import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, FileSystem, Path, PlatformError, Schema } from 'effect'
import { runHandler } from './run'

export const loadExtensionConfig = Effect.fnUntraced(
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
    const file = path.join(getAgentDir(), 'extensions', `${name}.json`)
    const contents = yield* fs.readFileString(file)
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(contents)
  },
  (load, ctx, _schema, name, defaults) =>
    runHandler(
      load.pipe(
        Effect.catchIf(
          (error) =>
            error._tag === 'PlatformError' && error.reason._tag === 'NotFound',
          () => Effect.succeed(defaults),
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
