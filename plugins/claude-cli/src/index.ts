import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Array } from 'effect'
import * as ClaudeCli from './claude-cli'

export default function claudeCli(pi: ExtensionAPI): void {
  pi.registerProvider('claude-cli', {
    name: 'Claude CLI',
    baseUrl: 'https://api.anthropic.com',
    // Pi requires a credential, but Claude Code signs in with its own login.
    apiKey: 'claude-cli',
    api: 'claude-cli',
    streamSimple: ClaudeCli.stream,
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

  pi.on('session_shutdown', () => ClaudeCli.release())
}
