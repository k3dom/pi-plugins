import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Effect, FileSystem, Path, Schema } from 'effect'

/**
 * Loads an extension's JSON config from `<agent-dir>/extensions/<name>.json` and
 * validates it with `schema`.
 */
export const loadExtensionConfig = Effect.fnUntraced(function* <
  S extends Schema.Top,
>(schema: S, name: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const file = path.join(getAgentDir(), 'extensions', `${name}.json`)
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    Effect.tapError((error) =>
      error._tag === 'PlatformError' && error.reason._tag === 'NotFound'
        ? Effect.void
        : Effect.logWarning(
            `Could not load ${name} config. [${error._tag}]: ${error.message}`,
          ),
    ),
  )
})
