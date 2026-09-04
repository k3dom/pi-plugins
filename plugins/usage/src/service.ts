import {
  type ModelRegistry,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import {
  Array,
  Cause,
  Context,
  Data,
  Effect,
  Encoding,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  String,
} from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'
import { HttpApiClient } from 'effect/unstable/httpapi'
import {
  ANTHROPIC_BASE_URL,
  ANTHROPIC_OAUTH_BETA,
  ClaudeUsageApi,
} from './provider/anthropic'
import { CHATGPT_BASE_URL, CodexUsageApi } from './provider/openai'

const REQUEST_TIMEOUT = '10 seconds'
const LOGIN_HINT = 'run /login to (re-)authenticate'

export class UsageServiceError extends Schema.TaggedErrorClass<UsageServiceError>()(
  '@pi-plugins/usage/UsageServiceError',
  {
    kind: Schema.Literals([
      'CredentialsMissing',
      'TokenRefreshFailed',
      'AccountIdMissing',
      'RequestFailed',
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const requestFailed = (cause: unknown) =>
  new UsageServiceError({
    kind: 'RequestFailed',
    message: Cause.isTimeoutError(cause)
      ? 'usage API request timed out'
      : cause instanceof Error &&
          typeof cause.message === 'string' &&
          cause.message.length > 0
        ? cause.message
        : 'usage API request failed',
    cause,
  })

export type UsageProvider = Data.TaggedEnum<{
  Anthropic: {}
  OpenAI: {}
}>
export const UsageProvider = Data.taggedEnum<UsageProvider>()

export type UsageCredentials = Data.TaggedEnum<{
  Anthropic: { readonly accessToken: string }
  OpenAI: { readonly accessToken: string; readonly accountId: string }
}>
export const UsageCredentials = Data.taggedEnum<UsageCredentials>()

type CredentialsFor<P extends UsageProvider> = Data.TaggedEnum.Value<
  UsageCredentials,
  P['_tag']
>

const accountIdFromToken = Effect.fnUntraced(function* (accessToken: string) {
  const payload = yield* Effect.fromResult(
    Encoding.decodeBase64UrlString(
      pipe(
        accessToken,
        String.split('.'),
        Array.get(1),
        Option.getOrElse(() => ''),
      ),
    ),
  )
  const claims = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        'https://api.openai.com/auth': Schema.Struct({
          chatgpt_account_id: Schema.String,
        }),
      }),
    ),
  )(payload)
  return claims['https://api.openai.com/auth'].chatgpt_account_id
})

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

      const credentials = Effect.fnUntraced(function* <P extends UsageProvider>(
        provider: P,
      ): Effect.fn.Return<CredentialsFor<P>, UsageServiceError> {
        const providerId = UsageProvider.$match(provider, {
          Anthropic: () => 'anthropic',
          OpenAI: () => 'openai-codex',
        })

        if (readStoredCredential(providerId)?.type !== 'oauth') {
          return yield* new UsageServiceError({
            kind: 'CredentialsMissing',
            message: `no subscription (OAuth) credentials found — ${LOGIN_HINT}`,
          })
        }
        const accessToken = yield* Effect.tryPromise({
          try: () => registry.getApiKeyForProvider(providerId),
          catch: (cause) =>
            new UsageServiceError({
              kind: 'TokenRefreshFailed',
              message: `token refresh failed — ${LOGIN_HINT}`,
              cause,
            }),
        })
        if (!accessToken) {
          return yield* new UsageServiceError({
            kind: 'TokenRefreshFailed',
            message: `token refresh failed — ${LOGIN_HINT}`,
          })
        }

        return (yield* UsageProvider.$match(provider, {
          Anthropic: () =>
            Effect.succeed(UsageCredentials.Anthropic({ accessToken })),
          OpenAI: Effect.fnUntraced(function* () {
            // Re-read: resolving the token may have refreshed the stored credential.
            const credential = readStoredCredential(providerId)
            const storedAccountId =
              credential?.type === 'oauth' &&
              typeof credential['accountId'] === 'string'
                ? credential['accountId']
                : undefined
            const accountId =
              storedAccountId ??
              (yield* accountIdFromToken(accessToken).pipe(
                Effect.orElseSucceed(() => undefined),
              ))
            if (!accountId) {
              return yield* new UsageServiceError({
                kind: 'AccountIdMissing',
                message: `missing ChatGPT account id — ${LOGIN_HINT}`,
              })
            }
            return UsageCredentials.OpenAI({ accessToken, accountId })
          }),
        })) as CredentialsFor<P>
      })

      const claude = Effect.fn('UsageService.claude')(function* () {
        const { accessToken } = yield* credentials(UsageProvider.Anthropic())
        const client = yield* HttpApiClient.makeWith(ClaudeUsageApi, {
          baseUrl: ANTHROPIC_BASE_URL,
          httpClient: http.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${accessToken}`,
                'anthropic-beta': ANTHROPIC_OAUTH_BETA,
              }),
            ),
          ),
        })
        return yield* client
          .usage()
          .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(requestFailed))
      })

      const codex = Effect.fn('UsageService.codex')(function* () {
        const { accessToken, accountId } = yield* credentials(UsageProvider.OpenAI())
        const client = yield* HttpApiClient.makeWith(CodexUsageApi, {
          baseUrl: CHATGPT_BASE_URL,
          httpClient: http.pipe(
            HttpClient.mapRequest(
              HttpClientRequest.setHeaders({
                Authorization: `Bearer ${accessToken}`,
                'ChatGPT-Account-Id': accountId,
              }),
            ),
          ),
        })
        return yield* client
          .usage()
          .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(requestFailed))
      })

      return { claude, codex } as const
    }),
  },
) {
  static readonly layer = (registry: ModelRegistry) =>
    Layer.effect(this, this.make(registry)).pipe(
      Layer.provide(FetchHttpClient.layer),
    )
}
