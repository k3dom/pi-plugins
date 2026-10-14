import type {
  AnthropicMessagesCompat,
  Api,
  ImageContent,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
} from '@earendil-works/pi-ai'
import { getCurrentTools } from '@earendil-works/pi-ai'
import { Array, Match, Number, Option, pipe, Predicate, String } from 'effect'

export type CacheTtl = '5m' | '1h'

type Image = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}

export type Block = (
  | { type: 'text'; text: string }
  | Image
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | Array<{ type: 'text'; text: string } | Image>
      is_error?: boolean
    }
) & { cache_control?: { type: 'ephemeral'; ttl: CacheTtl } }

export interface ApiMessage {
  role: 'user' | 'assistant'
  content: Array<Block>
}

const toBlock = (block: TextContent | ImageContent) =>
  block.type === 'text'
    ? { type: 'text' as const, text: block.text }
    : {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: block.mimeType,
          data: block.data,
        },
      }

const isBlank = (block: TextContent | ImageContent): boolean =>
  block.type === 'text' && !String.isNonEmpty(String.trim(block.text))

// Anthropic only accepts tool ids matching this pattern, but sessions can
// carry ids from other providers.
const toolId = (id: string): string =>
  pipe(id, String.replace(/[^a-zA-Z0-9_-]/g, '_'), String.takeLeft(64))

/**
 * Anthropic Messages API messages for a pi transcript, with the cache anchor
 * on the newest user message so the next request reuses the whole prefix.
 */
export function messages(
  transcript: ReadonlyArray<Message>,
  model: Model<Api>,
  cacheTtl: CacheTtl | undefined,
): Array<ApiMessage> {
  const result: Array<ApiMessage> = []
  let unanswered: Array<string> = []

  const pushUser = (content: Array<Block>): void => {
    if (!Array.isReadonlyArrayNonEmpty(content)) {
      return
    }
    pipe(
      Array.last(result),
      Option.filter((last) => last.role === 'user'),
      Option.match({
        onNone: () => result.push({ role: 'user', content }),
        onSome: (last) => last.content.push(...content),
      }),
    )
  }

  const answerPending = (): void => {
    pushUser(
      Array.map(unanswered, (id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: 'No result provided',
        is_error: true,
      })),
    )
    unanswered = []
  }

  for (const message of transcript) {
    if (message.role === 'user') {
      answerPending()
      pushUser(
        Predicate.isString(message.content)
          ? [{ type: 'text', text: message.content }]
          : pipe(
              message.content,
              Array.filter((block) => !isBlank(block)),
              Array.map(toBlock),
            ),
      )
    } else if (message.role === 'toolResult') {
      const id = toolId(message.toolCallId)
      unanswered = Array.filter(unanswered, (pending) => pending !== id)
      // As in pi's Anthropic provider, text alone travels as one string, which
      // may be empty where an empty text block would be rejected.
      const blocks = pipe(
        message.content,
        Array.filter((block) => !isBlank(block)),
        Array.map(toBlock),
      )
      const content = Match.value({
        image: Array.some(blocks, (block) => block.type === 'image'),
        text: Array.some(blocks, (block) => block.type === 'text'),
      }).pipe(
        Match.when({ image: false }, () =>
          pipe(
            message.content,
            Array.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
            Array.join('\n'),
          ),
        ),
        Match.when({ text: false }, () => [
          { type: 'text' as const, text: '(see attached image)' },
          ...blocks,
        ]),
        Match.orElse(() => blocks),
      )
      pushUser([
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(message.isError ? { is_error: true } : {}),
        },
      ])
    } else if (
      message.role === 'assistant' &&
      message.stopReason !== 'error' &&
      message.stopReason !== 'aborted'
    ) {
      answerPending()
      // Signatures only verify for the model that produced them.
      const native =
        message.provider === model.provider && message.model === model.id
      const content = Array.flatMap(message.content, (block): Array<Block> => {
        if (block.type === 'text') {
          return isBlank(block) ? [] : [{ type: 'text', text: block.text }]
        }
        if (block.type === 'toolCall') {
          const id = toolId(block.id)
          unanswered.push(id)
          return [{ type: 'tool_use', id, name: block.name, input: block.arguments }]
        }
        if (native && block.thinkingSignature) {
          return [
            block.redacted
              ? { type: 'redacted_thinking', data: block.thinkingSignature }
              : {
                  type: 'thinking',
                  thinking: block.thinking,
                  signature: block.thinkingSignature,
                },
          ]
        }
        return block.redacted || !String.isNonEmpty(String.trim(block.thinking))
          ? []
          : [{ type: 'text', text: block.thinking }]
      })
      if (Array.isReadonlyArrayNonEmpty(content)) {
        result.push({ role: 'assistant', content })
      }
    }
  }
  answerPending()

  if (cacheTtl !== undefined) {
    pipe(
      Array.last(result),
      Option.filter((last) => last.role === 'user'),
      Option.flatMap((last) => Array.last(last.content)),
      Option.map((block) => {
        block.cache_control = { type: 'ephemeral', ttl: cacheTtl }
      }),
    )
  }
  return result
}

/**
 * The fields of Claude Code's Messages API request that pi supplies, and the
 * effort to run at. Thinking mirrors pi's Anthropic provider, including its
 * default budgets for models without adaptive thinking.
 */
export function make(
  transcript: ReadonlyArray<Message>,
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  cacheTtl: CacheTtl | undefined,
) {
  const compat = model.compat as AnthropicMessagesCompat | undefined
  const managedEffort = compat?.supportsMidConvoEffort === true
  const level = options?.reasoning
  const effort = pipe(
    Option.fromNullishOr(level && model.thinkingLevelMap?.[level]),
    Option.getOrElse(() => (level === 'minimal' ? 'low' : level)),
  )
  let thinking: Record<string, unknown> | undefined
  let maxTokens = options?.maxTokens
  if (model.reasoning && (compat?.forceAdaptiveThinking || managedEffort)) {
    if (level !== undefined || managedEffort) {
      thinking = {
        type: 'adaptive',
        display: 'summarized',
        ...(managedEffort && {
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        }),
      }
    }
  } else if (model.reasoning && level !== undefined) {
    const budgets = {
      minimal: 1024,
      low: 2048,
      medium: 8192,
      high: 16384,
      ...options?.thinkingBudgets,
    }
    const budget = budgets[level === 'xhigh' || level === 'max' ? 'high' : level]
    maxTokens = Number.min(
      (options?.maxTokens ?? model.maxTokens) + budget,
      model.maxTokens,
    )
    thinking = {
      type: 'enabled',
      budget_tokens: Number.min(budget, maxTokens - 1024),
      display: 'summarized',
    }
  }

  return {
    effort,
    body: {
      messages: messages(transcript, model, cacheTtl),
      tools: Array.map(getCurrentTools(transcript), (tool) => {
        const schema = tool.parameters as {
          properties?: unknown
          required?: unknown
        }
        return {
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object',
            properties: schema.properties ?? {},
            required: schema.required ?? [],
          },
        }
      }),
      ...(options?.toolChoice && { tool_choice: { type: options.toolChoice } }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
      ...(thinking && { thinking }),
    },
  }
}
