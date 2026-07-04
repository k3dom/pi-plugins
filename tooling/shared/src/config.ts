import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Effect, Schema } from 'effect'

/**
 * A config schema decodable without external services, so it can be decoded
 * synchronously. Give every field a decoding default
 * (`Schema.withDecodingDefault`) so the schema is the single source of truth
 * for default values: `{}` then decodes to a fully populated config.
 */
export type ExtensionConfigSchema = Schema.Top & Schema.Decoder<unknown, never>

/**
 * Loads an extension's JSON config from `<agent-dir>/extensions/<name>.json`
 * and validates it with `schema`. Returns the schema's defaults when the file
 * is missing; an unreadable or invalid file also logs a warning.
 */
export function loadExtensionConfig<S extends ExtensionConfigSchema>(
  schema: S,
  name: string,
): S['Type'] {
  const path = join(getAgentDir(), 'extensions', `${name}.json`)
  const defaults = Schema.decodeUnknownSync(schema)({})
  if (!existsSync(path)) return defaults

  return Effect.try({
    try: () => readFileSync(path, 'utf-8'),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
    Effect.tapError((error) =>
      Effect.sync(() => console.error(`Warning: could not load ${path}: ${error}`)),
    ),
    Effect.orElseSucceed(() => defaults),
    Effect.runSync,
  )
}
