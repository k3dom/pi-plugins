import { describe, expect, test, vi } from 'vitest'
import { wrapFetchForCch } from '../src/cch'

const REQUEST_URL = 'https://api.anthropic.com/v1/messages'

const requestBody = JSON.stringify({
  model: 'claude-opus-5-5',
  max_tokens: 128000,
  messages: [{ role: 'user', content: 'héllo 🌍; cch=00000' }],
  system: [
    {
      type: 'text',
      text: 'x-anthropic-billing-header: cc_version=2.1.280.9d3; cc_entrypoint=local-agent; cch=00000; cc_prompt_id=00000000-0000-4000-8000-000000000000; cc_turn_origin=sdk;',
    },
  ],
  fallbacks: [{ model: 'claude-opus-5' }],
  fallback_credit_token: 'test-credit',
  stream: true,
})

describe('wrapFetchForCch', () => {
  test('matches the libxxhash 0.8.3 vector after excluding routing fields', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const wrapped = wrapFetchForCch(base, {})

    await wrapped(REQUEST_URL, { method: 'POST', body: requestBody })

    expect(base).toHaveBeenCalledOnce()
    const sentBody = Buffer.from(
      base.mock.lastCall![1]!.body as Uint8Array,
    ).toString()
    expect(sentBody).toBe(
      requestBody.replace('cch=00000; cc_prompt_id=', 'cch=17df5; cc_prompt_id='),
    )
  })

  test('merges and deduplicates request betas without dropping pi-specific features', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const wrapped = wrapFetchForCch(base, {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    })

    await wrapped(REQUEST_URL, {
      method: 'POST',
      headers: {
        'anthropic-beta':
          'oauth-2025-04-20,server-side-fallback-2026-07-01,mid-conversation-output-config-2026-07-01',
      },
      body: requestBody,
    })

    const sentHeaders = new Headers(base.mock.lastCall?.[1]?.headers)
    expect(sentHeaders.get('anthropic-beta')?.split(',')).toEqual([
      'claude-code-20250219',
      'oauth-2025-04-20',
      'server-side-fallback-2026-07-01',
      'mid-conversation-output-config-2026-07-01',
    ])
  })

  test('passes unrelated requests through untouched', async () => {
    const base = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))
    const wrapped = wrapFetchForCch(base, {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    })
    const init = {
      method: 'POST',
      headers: { authorization: 'Bearer unrelated-token' },
      body: JSON.stringify({ model: 'other-model', messages: [] }),
    }

    const expected = structuredClone(init)

    await wrapped('https://example.com/messages', init)

    expect(base).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/messages',
      expected,
    )
  })
})
