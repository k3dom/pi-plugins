import { assert, describe, it } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import * as Cch from '../src/cch'

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

const recordingFetch = () => {
  const calls: Array<Parameters<typeof fetch>> = []
  const base: typeof fetch = async (...args) => {
    calls.push(args)
    return new Response(null, { status: 204 })
  }
  return { base, calls }
}

describe('wrapFetch', () => {
  it('matches the libxxhash 0.8.3 vector after excluding routing fields', async () => {
    const { base, calls } = recordingFetch()

    await Cch.wrapFetch(base, {})(REQUEST_URL, { method: 'POST', body: requestBody })

    assert.lengthOf(calls, 1)
    const sentBody = Buffer.from(calls[0]?.[1]?.body as Uint8Array).toString()
    assert.strictEqual(
      sentBody,
      requestBody.replace('cch=00000; cc_prompt_id=', 'cch=17df5; cc_prompt_id='),
    )
  })

  it('merges and deduplicates request betas without dropping pi-specific features', async () => {
    const { base, calls } = recordingFetch()

    await Cch.wrapFetch(base, {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    })(REQUEST_URL, {
      method: 'POST',
      headers: {
        'anthropic-beta':
          'oauth-2025-04-20,server-side-fallback-2026-07-01,mid-conversation-output-config-2026-07-01',
      },
      body: requestBody,
    })

    const sentHeaders = new Headers(calls[0]?.[1]?.headers)
    deepStrictEqual(sentHeaders.get('anthropic-beta')?.split(','), [
      'claude-code-20250219',
      'oauth-2025-04-20',
      'server-side-fallback-2026-07-01',
      'mid-conversation-output-config-2026-07-01',
    ])
  })

  it('passes unrelated requests through untouched', async () => {
    const { base, calls } = recordingFetch()
    const init = {
      method: 'POST',
      headers: { authorization: 'Bearer unrelated-token' },
      body: JSON.stringify({ model: 'other-model', messages: [] }),
    }

    const expected = structuredClone(init)

    await Cch.wrapFetch(base, {
      'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
    })('https://example.com/messages', init)

    deepStrictEqual(calls, [['https://example.com/messages', expected]])
  })
})
