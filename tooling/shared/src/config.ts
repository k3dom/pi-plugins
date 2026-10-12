import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, FileSystem, Path, PlatformError, Schema } from 'effect'
import * as Run from './run'

export const load = Effect.fnUntraced(
  function* <S extends Schema.Codec<unknown>>(
    _ctx: ExtensionContext,
    schema: S,
    name: string,
    _defaults: S['Type'],
  ): Effect.fn.Return<
    S['Type'],
    Schema.SchemaError | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  > {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const contents = yield* fs.readFileString(
      path.join(getAgentDir(), 'extensions', `${name}.json`),
    )
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents)
  },
  (effect, ctx, _schema, name, defaults) =>
    Run.handler(
      effect.pipe(
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.succeed(defaults),
        ),
        Effect.provide(NodeServices.layer),
      ),
      {
        onError: (message) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Ignoring invalid ${name} config: ${message}`, 'warning')
          }
          return defaults
        },
      },
    ),
)
