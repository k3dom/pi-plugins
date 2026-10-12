import {
  type ModelRegistry,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import {
  Cause,
  Context,
  Effect,
  Layer,
  Option,
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
      RequestFailed,
      GlmApiFailed,
    ]),
  },
) {
  override get message(): string {
    return this.reason.message
  }
}

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
    make: Effect.fnUntraced(function* (registry: ModelRegistry) {
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

      const claude = Effect.fn('UsageService.claude')(function* () {
        const accessToken = yield* oauthToken('anthropic')
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

      return { claude, codex, glm } as const
    }),
  },
) {}

export const layer = (registry: ModelRegistry) =>
  Layer.effect(UsageService, UsageService.make(registry)).pipe(
    Layer.provide(FetchHttpClient.layer),
  )
