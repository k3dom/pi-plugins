import type {
  Api,
  ImageContent,
  Message,
  Model,
  TextContent,
} from '@earendil-works/pi-ai'

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
      content: Array<{ type: 'text'; text: string } | Image>
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

// Anthropic only accepts tool ids matching this pattern, but sessions can
// carry ids from other providers.
const toolId = (id: string): string =>
  id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)

/**
 * Anthropic Messages API messages for a pi transcript, with the cache anchor
 * on the newest user message so the next request reuses the whole prefix.
 */
export function fromTranscript(
  messages: ReadonlyArray<Message>,
  model: Model<Api>,
  cacheTtl: CacheTtl | undefined,
): Array<ApiMessage> {
  const result: Array<ApiMessage> = []
  let unanswered: Array<string> = []

  const pushUser = (content: Array<Block>): void => {
    if (content.length === 0) {
      return
    }
    const last = result.at(-1)
    if (last?.role === 'user') {
      last.content.push(...content)
    } else {
      result.push({ role: 'user', content })
    }
  }

  const answerPending = (): void => {
    pushUser(
      unanswered.map((id) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'text', text: 'No result provided' }],
        is_error: true,
      })),
    )
    unanswered = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      answerPending()
      const content: Array<TextContent | ImageContent> =
        typeof message.content === 'string'
          ? [{ type: 'text', text: message.content }]
          : message.content
      pushUser(
        content
          .filter((block) => block.type !== 'text' || block.text.trim() !== '')
          .map(toBlock),
      )
    } else if (message.role === 'toolResult') {
      const id = toolId(message.toolCallId)
      unanswered = unanswered.filter((pending) => pending !== id)
      pushUser([
        {
          type: 'tool_result',
          tool_use_id: id,
          content: message.content.map(toBlock),
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
      const content: Array<Block> = []
      for (const block of message.content) {
        if (block.type === 'text') {
          if (block.text.trim() !== '') {
            content.push({ type: 'text', text: block.text })
          }
        } else if (block.type === 'toolCall') {
          const id = toolId(block.id)
          unanswered.push(id)
          content.push({
            type: 'tool_use',
            id,
            name: block.name,
            input: block.arguments,
          })
        } else if (native && block.thinkingSignature) {
          content.push(
            block.redacted
              ? { type: 'redacted_thinking', data: block.thinkingSignature }
              : {
                  type: 'thinking',
                  thinking: block.thinking,
                  signature: block.thinkingSignature,
                },
          )
        } else if (!block.redacted && block.thinking.trim() !== '') {
          content.push({ type: 'text', text: block.thinking })
        }
      }
      if (content.length > 0) {
        result.push({ role: 'assistant', content })
      }
    }
  }
  answerPending()

  const last = result.at(-1)
  const anchor = last?.role === 'user' ? last.content.at(-1) : undefined
  if (anchor !== undefined && cacheTtl !== undefined) {
    anchor.cache_control = { type: 'ephemeral', ttl: cacheTtl }
  }
  return result
}
