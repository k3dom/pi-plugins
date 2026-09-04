import { describe, expect, test, vi } from 'vitest'
import { wrapFetchForCch } from '../src/cch'

const CLAUDE_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'context-management-2025-06-27',
]
const PI_BETAS = [
  'oauth-2025-04-20',
  'server-side-fallback-2026-07-01',
  'mid-conversation-output-config-2026-07-01',
  'thinking-binding-controls-2026-08-01',
]

const REQUEST_URL = 'https://api.anthropic.com/v1/messages'

const cchRequestBody = JSON.stringify({
  model: 'claude-fable-5-1',
  messages: [
    { role: 'user', content: 'Hello' },
    { role: 'system', content: [], output_config: { effort: 'high' } },
  ],
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=00000;' }],
})

const betaFeatures = (headers: Headers): string[] =>
  (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)

const createBaseFetch = () =>
  vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

describe('wrapFetchForCch', () => {
  test('preserves pi request betas when applying Claude Code headers', async () => {
    const base = createBaseFetch()
    const wrapped = wrapFetchForCch(base, {
      'anthropic-beta': CLAUDE_BETAS.join(','),
    })

    await wrapped(REQUEST_URL, {
      method: 'POST',
      headers: { 'anthropic-beta': PI_BETAS.join(',') },
      body: cchRequestBody,
    })

    expect(base).toHaveBeenCalledOnce()
    const sentHeaders = new Headers(base.mock.lastCall?.[1]?.headers)
    const expectedBetas = [...new Set([...CLAUDE_BETAS, ...PI_BETAS])]
    expect(betaFeatures(sentHeaders).toSorted()).toEqual(expectedBetas.toSorted())
  })

  test('passes requests without the cch placeholder through untouched', async () => {
    const base = createBaseFetch()
    const wrapped = wrapFetchForCch(base, {
      'anthropic-beta': CLAUDE_BETAS.join(','),
    })
    const init = {
      method: 'POST',
      headers: { 'anthropic-beta': PI_BETAS.join(',') },
      body: JSON.stringify({ model: 'claude-fable-5-1', messages: [] }),
    }

    await wrapped(REQUEST_URL, init)

    expect(base).toHaveBeenCalledExactlyOnceWith(REQUEST_URL, init)
  })
})
