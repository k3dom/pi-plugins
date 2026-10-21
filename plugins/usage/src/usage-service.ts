import { homedir } from 'node:os'
import {
  type ModelRegistry,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Cause,
  Config,
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  pipe,
  Predicate,
  Schedule,
  Schema,
  String,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { HttpApiClient } from 'effect/unstable/httpapi'
import * as Anthropic from './provider/anthropic'
import * as OpenAI from './provider/openai'
import * as Zai from './provider/zai'

const REQUEST_TIMEOUT = '10 seconds'
const LOGIN_HINT = 'run /login to (re-)authenticate'

export class CredentialsMissing extends Schema.TaggedError<CredentialsMissing>()(
  'CredentialsMissing',
  { providerId: Schema.String, credential: Schema.Literals(['oauth', 'api_key']) },
) {
  override get message(): string {
    const missing =
      this.credential === 'oauth'
        ? 'no subscription (OAuth) credentials found'
        : `no API key found for ${this.providerId}`
    return `${missing} — ${LOGIN_HINT}`
  }
}

export class TokenRefreshFailed extends Schema.TaggedError<TokenRefreshFailed>()(
  'TokenRefreshFailed',
  { providerId: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `token refresh failed — ${LOGIN_HINT}`
  }
}

export class AccountIdMissing extends Schema.TaggedError<AccountIdMissing>()(
  'AccountIdMissing',
  {},
) {
  override get message(): string {
    return `missing ChatGPT account id — ${LOGIN_HINT}`
  }
}

export class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  'RequestFailed',
  { cause: Schema.Defect() },
) {
  override get message(): string {
    if (Cause.isTimeoutError(this.cause)) {
      return 'usage API request timed out'
    }
    return Predicate.isError(this.cause) && String.isNonEmpty(this.cause.message)
      ? this.cause.message
      : 'usage API request failed'
  }
}

export class ClaudeCodeLoginMissing extends Schema.TaggedError<ClaudeCodeLoginMissing>()(
  'ClaudeCodeLoginMissing',
  { path: Schema.String },
) {
  override get message(): string {
    return process.platform === 'darwin'
      ? `no Claude Code login found in ${this.path} — on macOS Claude Code keeps its login in the Keychain, which this plugin can't read yet`
      : `no Claude Code login found in ${this.path} — run \`claude auth login\``
  }
}

export class ClaudeCodeLoginUnreadable extends Schema.TaggedError<ClaudeCodeLoginUnreadable>()(
  'ClaudeCodeLoginUnreadable',
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `couldn't read Claude Code's login from ${this.path} — check the file, or run \`claude auth login\` to rewrite it`
  }
}

export class ClaudeCodeLoginExpired extends Schema.TaggedError<ClaudeCodeLoginExpired>()(
  'ClaudeCodeLoginExpired',
  {},
) {
  override get message(): string {
    return "Claude Code's access token has expired — it renews it on its next request"
  }
}

/** The GLM API answers HTTP 200 for failures too, so filterStatusOk can't catch them. */
export class GlmApiFailed extends Schema.TaggedError<GlmApiFailed>()(
  'GlmApiFailed',
  { code: Schema.Number, msg: Schema.optional(Schema.NullOr(Schema.String)) },
) {
  override get message(): string {
    return this.msg || `GLM usage API error (code ${this.code})`
  }
}

export class UsageServiceError extends Schema.TaggedError<UsageServiceError>()(
  'UsageServiceError',
  {
    reason: Schema.Union([
      CredentialsMissing,
      TokenRefreshFailed,
      AccountIdMissing,
      ClaudeCodeLoginMissing,
      ClaudeCodeLoginUnreadable,
      ClaudeCodeLoginExpired,
      RequestFailed,
      GlmApiFailed,
    ]),
  },
) {
  override get message(): string {
    return this.reason.message
  }
}

const ClaudeCodeCredentials = Schema.fromJsonString(Schema.Unknown)

const ClaudeCodeLogin = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    expiresAt: Schema.DateTimeUtcFromMillis,
  }),
})

const StoredCodexCredential = Schema.Struct({
  type: Schema.Literal('oauth'),
  accountId: Schema.String,
})

const AccessToken = Schema.TemplateLiteralParser([
  Schema.String,
  '.',
  Schema.StringFromBase64Url.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(
        Schema.Struct({
          'https://api.openai.com/auth': Schema.Struct({
            chatgpt_account_id: Schema.String,
          }),
        }),
      ),
    ),
  ),
  '.',
  Schema.String,
])

export class UsageService extends Context.Service<UsageService>()(
  '@pi-plugins/usage/UsageService',
  {
    make: Effect.fnUntraced(function* (
      registry: ModelRegistry,
      claudeCodeCredentials: string,
    ) {
      const fs = yield* FileSystem.FileSystem
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.acceptJson),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({
          times: 3,
          schedule: Schedule.jittered(Schedule.exponential('1 second')),
        }),
      )

      const send = <A, E, R>(request: Effect.Effect<A, E, R>) =>
        request.pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError(
            (cause) =>
              new UsageServiceError({ reason: new RequestFailed({ cause }) }),
          ),
        )

      const apiKey = (providerId: string) =>
        Effect.tryPromise({
          try: () => registry.getApiKeyForProvider(providerId),
          catch: (cause) =>
            new UsageServiceError({
              reason: new TokenRefreshFailed({ providerId, cause }),
            }),
        })

      const oauthToken = Effect.fnUntraced(function* (providerId: string) {
        if (readStoredCredential(providerId)?.type !== 'oauth') {
          return yield* new UsageServiceError({
            reason: new CredentialsMissing({ providerId, credential: 'oauth' }),
          })
        }
        const token = yield* apiKey(providerId)
        if (!token) {
          return yield* new UsageServiceError({
            reason: new TokenRefreshFailed({ providerId }),
          })
        }
        return token
      })

      const claudeUsage = Effect.fnUntraced(function* (accessToken: string) {
        const client = yield* HttpApiClient.makeWith(Anthropic.UsageApi, {
          baseUrl: Anthropic.BASE_URL,
          httpClient: http.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${accessToken}`,
                'anthropic-beta': Anthropic.OAUTH_BETA,
              }),
            ),
          ),
        })
        const [usage, profile] = yield* Effect.all(
          [
            client.usage().pipe(send),
            // Only decorates the report, so it must never fail the usage fetch.
            client.profile().pipe(
              Effect.timeout(REQUEST_TIMEOUT),
              Effect.orElseSucceed(() => undefined),
            ),
          ],
          { concurrency: 'unbounded' },
        )
        return { usage, profile } satisfies Anthropic.AccountUsage
      })

      const claude = Effect.fn('UsageService.claude')(function* () {
        return yield* claudeUsage(yield* oauthToken('anthropic'))
      })

      /**
       * Usage of the account Claude Code is logged into, which the `claude-cli`
       * provider bills. Claude Code rotates the refresh token whenever it renews
       * the access token, so this only reads its login and never renews it.
       */
      const claudeCode = Effect.fn('UsageService.claudeCode')(function* () {
        const fail = (reason: UsageServiceError['reason']) =>
          Effect.fail(new UsageServiceError({ reason }))
        const path = claudeCodeCredentials
        const credentials = yield* fs.readFileString(path).pipe(
          Effect.flatMap(Schema.decodeEffect(ClaudeCodeCredentials)),
          Effect.catchReason('PlatformError', 'NotFound', () =>
            fail(new ClaudeCodeLoginMissing({ path })),
          ),
          Effect.catchTags({
            PlatformError: (cause) =>
              fail(new ClaudeCodeLoginUnreadable({ path, cause })),
            SchemaError: (cause) =>
              fail(new ClaudeCodeLoginUnreadable({ path, cause })),
          }),
        )
        const login = Schema.decodeUnknownOption(ClaudeCodeLogin)(credentials)
        if (Option.isNone(login)) {
          return yield* fail(new ClaudeCodeLoginMissing({ path }))
        }
        const { accessToken, expiresAt } = login.value.claudeAiOauth
        if (DateTime.isLessThanOrEqualTo(expiresAt, yield* DateTime.now)) {
          return yield* fail(new ClaudeCodeLoginExpired())
        }
        return yield* claudeUsage(accessToken)
      })

      const codex = Effect.fn('UsageService.codex')(function* () {
        const accessToken = yield* oauthToken('openai-codex')
        // Re-read: resolving the token may have refreshed the stored credential.
        const accountId = pipe(
          Schema.decodeUnknownOption(StoredCodexCredential)(
            readStoredCredential('openai-codex'),
          ),
          Option.map((credential) => credential.accountId),
          Option.orElse(() =>
            pipe(
              Schema.decodeUnknownOption(AccessToken)(accessToken),
              Option.map(
                ([, , claims]) =>
                  claims['https://api.openai.com/auth'].chatgpt_account_id,
              ),
            ),
          ),
          Option.filter(String.isNonEmpty),
        )
        if (Option.isNone(accountId)) {
          return yield* new UsageServiceError({ reason: new AccountIdMissing() })
        }
        const client = yield* HttpApiClient.makeWith(OpenAI.UsageApi, {
          baseUrl: OpenAI.BASE_URL,
          httpClient: http.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${accessToken}`,
                'ChatGPT-Account-Id': accountId.value,
              }),
            ),
          ),
        })
        return yield* client.usage().pipe(send)
      })

      const glm = Effect.fn('UsageService.glm')(function* (
        providerId: Zai.Provider,
      ) {
        const key = yield* apiKey(providerId)
        if (!key) {
          return yield* new UsageServiceError({
            reason: new CredentialsMissing({ providerId, credential: 'api_key' }),
          })
        }
        const client = yield* HttpApiClient.makeWith(Zai.UsageApi, {
          baseUrl: Zai.BASE_URL[providerId],
          httpClient: http.pipe(
            HttpClient.mapRequest(HttpClientRequest.bearerToken(key)),
          ),
        })
        const envelope = yield* client.usage().pipe(send)
        if (!envelope.success) {
          return yield* new UsageServiceError({
            reason: new GlmApiFailed({ code: envelope.code, msg: envelope.msg }),
          })
        }
        return envelope.data
      })

      return { claude, claudeCode, codex, glm } as const
    }),
  },
) {}

export const layer = (registry: ModelRegistry) =>
  Layer.effect(
    UsageService,
    Effect.gen(function* () {
      const path = yield* Path.Path
      // Where Claude Code itself looks, which the claude CLI inherits from pi.
      const configDir = yield* Config.String('CLAUDE_CONFIG_DIR').pipe(
        Config.withDefault(path.join(homedir(), '.claude')),
      )
      return yield* UsageService.make(
        registry,
        path.join(configDir, '.credentials.json'),
      )
    }),
  ).pipe(Layer.provide([FetchHttpClient.layer, NodeServices.layer]))
