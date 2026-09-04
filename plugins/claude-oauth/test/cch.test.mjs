import assert from 'node:assert/strict'
import { test } from 'node:test'
import { wrapFetchForCch } from '../src/cch.ts'

const betaFeatures = (headers) =>
  (headers.get('anthropic-beta') ?? '')
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)

test('preserves pi request betas when applying Claude Code headers', async () => {
  const claudeBetas = [
    'claude-code-20250219',
    'oauth-2025-04-20',
    'context-management-2025-06-27',
  ]
  const piBetas = [
    'oauth-2025-04-20',
    'server-side-fallback-2026-07-01',
    'mid-conversation-output-config-2026-07-01',
    'thinking-binding-controls-2026-08-01',
  ]
  let sentHeaders
  const baseFetch = async (_input, init) => {
    sentHeaders = new Headers(init?.headers)
    return new Response(null, { status: 204 })
  }
  const wrapped = wrapFetchForCch(baseFetch, {
    'anthropic-beta': claudeBetas.join(','),
  })
  const body = JSON.stringify({
    model: 'claude-fable-5-1',
    messages: [
      { role: 'user', content: 'Hello' },
      {
        role: 'system',
        content: [],
        output_config: { effort: 'high' },
      },
    ],
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: cch=00000;',
      },
    ],
  })

  await wrapped('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'anthropic-beta': piBetas.join(',') },
    body,
  })

  assert.ok(sentHeaders)
  const sentBetas = betaFeatures(sentHeaders)
  const expectedBetas = [...new Set([...claudeBetas, ...piBetas])]
  assert.deepEqual(new Set(sentBetas), new Set(expectedBetas))
  assert.equal(sentBetas.length, expectedBetas.length)
})
