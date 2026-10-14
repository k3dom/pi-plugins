import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'

export const model: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-haiku-4-5'),
  provider: 'claude-cli',
  api: 'claude-cli',
}

export const user = (text: string): Message => ({
  role: 'user',
  content: text,
  timestamp: 0,
})

export const assistant = (
  content: AssistantMessage['content'],
  overrides?: Partial<AssistantMessage>,
): Message => ({
  role: 'assistant',
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
  ...overrides,
})

export const toolResult = (toolCallId: string, text: string): Message => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 0,
})
