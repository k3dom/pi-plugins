import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Array } from 'effect'
import * as ClaudeCode from './claude-code'

export default function claudeCode(pi: ExtensionAPI): void {
  pi.registerProvider('claude-code', {
    name: 'Claude Code',
    baseUrl: 'https://api.anthropic.com',
    // Pi requires a credential, but Claude Code signs in with its own login.
    apiKey: 'claude-code',
    api: 'claude-code',
    streamSimple: ClaudeCode.stream,
    // Without `promptCache`, pi does not warm the cache with replayed requests.
    models: Array.map(getBuiltinModels('anthropic'), (model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      compat: model.compat,
    })),
  })
}
