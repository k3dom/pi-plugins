import { createHash, randomUUID } from 'node:crypto'
import {
  arch as osArch,
  homedir,
  hostname,
  platform as osPlatform,
  userInfo,
} from 'node:os'
import {
  Array,
  Match,
  Option,
  pipe,
  Predicate,
  Result,
  Schema,
  String,
} from 'effect'
import * as Constants from './constants'
import * as SystemPrompt from './system-prompt'

export function headers(): Record<string, string> {
  return {
    'user-agent': `claude-cli/${Constants.CLAUDE_CODE_VERSION} (external, local-agent, agent-sdk/${Constants.CLAUDE_AGENT_SDK_VERSION})`,
    'anthropic-beta': Array.join(Constants.CLAUDE_CODE_AGENT_BETAS, ','),
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime-version': Constants.CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
    'x-stainless-package-version': Constants.CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
    'x-stainless-runtime': 'node',
    'x-stainless-lang': 'js',
    'x-stainless-arch': Match.value<string>(String.toLowerCase(osArch())).pipe(
      Match.whenOr('amd64', 'x64', () => 'x64'),
      Match.whenOr('arm64', 'aarch64', () => 'arm64'),
      Match.whenOr('386', 'x86', 'ia32', () => 'x86'),
      Match.orElse((key) => `other::${key}`),
    ),
    'x-stainless-os': Match.value<string>(String.toLowerCase(osPlatform())).pipe(
      Match.when('darwin', () => 'MacOS'),
      Match.whenOr('win32', 'windows', () => 'Windows'),
      Match.when('linux', () => 'Linux'),
      Match.when('freebsd', () => 'FreeBSD'),
      Match.orElse((key) => `Other::${key}`),
    ),
    'x-stainless-timeout': globalThis.String(
      Constants.CLAUDE_CODE_STAINLESS_TIMEOUT,
    ),
  }
}

// Claude Code sends `metadata.user_id` as a JSON identity envelope: `device_id`
// is machine-stable, `session_id` is per process. `userInfo()` can throw in
// locked-down sandboxes.
const machineSeed = pipe(
  Result.try(() => `${hostname()}:${userInfo().username}:${homedir()}`),
  Result.getOrElse(() => `${hostname()}:claude-oauth-fallback`),
)
const deviceId = createHash('sha256')
  .update(`claude-oauth-device-v1:${machineSeed}`)
  .digest('hex')
const sessionId = randomUUID()

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
})

const Metadata = Schema.Struct({
  user_id: Schema.fromJsonString(Schema.Struct({ account_uuid: Schema.String })),
})

const sanitizeBlocks = (blocks: ReadonlyArray<unknown>) =>
  Array.flatMap(blocks, (block) => {
    if (!Schema.is(TextBlock)(block)) {
      return [block]
    }
    const text = SystemPrompt.sanitize(block.text)
    return String.isNonEmpty(text) ? [{ ...block, text }] : []
  })

// Mutated in place so fields this plugin does not model pass through untouched.
export function rewrite(payload: unknown) {
  if (!Predicate.isObject(payload)) {
    return undefined
  }
  const system = payload['system']
  const [sentinel, ...rest] = Array.isArray(system) ? system : []
  if (
    !Predicate.isObject(sentinel) ||
    sentinel['text'] !== Constants.PI_ANTHROPIC_OAUTH_SENTINEL
  ) {
    return undefined
  }

  // Models with native mid-conversation system messages receive later prompt
  // updates as `role: "system"` messages instead of collapsing them into `system`.
  const messages = payload['messages']
  if (Array.isArray(messages)) {
    payload['messages'] = Array.flatMap(messages, (message) => {
      if (
        !Predicate.isObject(message) ||
        message['role'] !== 'system' ||
        !Array.isArray(message['content'])
      ) {
        return [message]
      }
      const content = sanitizeBlocks(message['content'])
      if (Array.isArrayNonEmpty(message['content']) && Array.isArrayEmpty(content)) {
        return []
      }
      return [{ ...message, content }]
    })
  }

  const firstUserMessage = pipe(
    Array.isArray(messages) ? messages : [],
    Array.findFirst((message) =>
      Predicate.isObject(message) && message['role'] === 'user'
        ? Option.some(message['content'])
        : Option.none(),
    ),
    Option.flatMap((content) => {
      if (Predicate.isString(content)) {
        return Option.some(content)
      }
      return pipe(
        Array.isArray(content) ? content : [],
        Array.findFirst(Schema.is(TextBlock)),
        Option.map((block) => block.text),
      )
    }),
    Option.getOrElse(() => ''),
  )
  const fingerprintSeed = pipe(
    Constants.CLAUDE_CODE_BILLING_FINGERPRINT_INDICES,
    Array.map((index) =>
      pipe(
        firstUserMessage,
        String.charAt(index),
        Option.getOrElse(() => '0'),
      ),
    ),
    Array.join(''),
  )
  const versionSuffix = String.takeLeft(
    createHash('sha256')
      .update(
        `${Constants.CLAUDE_CODE_BILLING_FINGERPRINT_SALT}${fingerprintSeed}${Constants.CLAUDE_CODE_VERSION}`,
      )
      .digest('hex'),
    3,
  )
  payload['system'] = [
    {
      type: 'text',
      text: `${Constants.CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${Constants.CLAUDE_CODE_VERSION}.${versionSuffix}; cc_entrypoint=local-agent; ${Constants.CCH_PLACEHOLDER}; cc_prompt_id=${randomUUID()}; cc_turn_origin=sdk;`,
    },
    { ...sentinel, text: Constants.CLAUDE_AGENT_SDK_IDENTITY },
    ...sanitizeBlocks(rest),
  ]

  const metadata = payload['metadata']
  payload['metadata'] = {
    ...(Predicate.isObject(metadata) ? metadata : {}),
    user_id: JSON.stringify({
      device_id: deviceId,
      account_uuid: pipe(
        Schema.decodeUnknownOption(Metadata)(metadata),
        Option.map(({ user_id }) => user_id.account_uuid),
        Option.getOrElse(() => ''),
      ),
      session_id: sessionId,
    }),
  }

  const thinking = payload['thinking']
  if (
    Predicate.isObject(thinking) &&
    (thinking['type'] === 'adaptive' || thinking['type'] === 'enabled')
  ) {
    payload['context_management'] = {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    }
  }
  payload['diagnostics'] = { previous_message_id: null }

  return payload
}
