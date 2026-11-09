import { createProvider, type Api } from '@earendil-works/pi-ai/compat'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Array } from 'effect'
import * as ClaudeCli from './claude-cli'

export default function claudeCli(pi: ExtensionAPI): void {
  // Pi applies models.json above a complete provider, but drops models.json
  // models when a provider config lists its own.
  pi.registerProvider(
    createProvider<Api>({
      id: 'claude-cli',
      name: 'Claude CLI',
      baseUrl: 'https://api.anthropic.com',
      auth: {
        // Pi requires a credential, but Claude Code signs in with its own login.
        apiKey: {
          name: 'Claude Code login',
          resolve: async () => ({
            auth: { apiKey: 'claude-cli' },
            source: 'Claude Code',
          }),
        },
      },
      api: { stream: ClaudeCli.stream, streamSimple: ClaudeCli.stream },
      // Without `promptCache`, pi does not warm the cache with replayed requests.
      models: Array.map(getBuiltinModels('anthropic'), (model) => ({
        id: model.id,
        name: model.name,
        api: 'claude-cli',
        provider: 'claude-cli',
        baseUrl: 'https://api.anthropic.com',
        reasoning: model.reasoning,
        thinkingLevelMap: model.thinkingLevelMap,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      })),
    }),
  )
}
