import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recentText, streamingText } from '../src/render.ts'
import { createSpeedTracker } from '../src/service.ts'

const outcome = {
  model: 'provider/model',
  stopReason: 'stop',
  outputTokens: 100,
  reasoningTokens: undefined,
}

test('times nonempty chunks, excludes the opening chunk and ignores teardown', (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const tracker = createSpeedTracker()
  tracker.beginRequest()
  now = 100
  assert.equal(tracker.recordDelta('thinking', 0), undefined)
  now = 1000
  assert.deepEqual(tracker.recordDelta('visible', 4), { ttftMs: 1000 })
  now = 2000
  tracker.recordDelta('visible', 396)
  now = 3000
  tracker.recordDelta('visible', 0)
  now = 5000
  tracker.endRequest(outcome)
  assert.deepEqual(tracker.recent(outcome.model), { tps: 99, ttftMs: 1000 })
})

for (const scenario of [
  { name: 'error', stopReason: 'error', outputTokens: 100, duration: 1000 },
  { name: 'abort', stopReason: 'aborted', outputTokens: 100, duration: 1000 },
  { name: 'missing usage', stopReason: 'stop', outputTokens: 0, duration: 1000 },
  { name: 'buffer flush', stopReason: 'stop', outputTokens: 100, duration: 1 },
  {
    name: 'single chunk',
    stopReason: 'stop',
    outputTokens: 100,
    duration: undefined,
  },
]) {
  test(`does not report throughput for ${scenario.name}`, (t) => {
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const tracker = createSpeedTracker()
    tracker.beginRequest()
    now = 1000
    tracker.recordDelta('visible', 4)
    if (scenario.duration !== undefined) {
      now += scenario.duration
      tracker.recordDelta('visible', 396)
    }
    now += 1000
    tracker.recordDelta('thinking', 0)
    tracker.endRequest({ ...outcome, ...scenario })
    assert.equal(tracker.recent(outcome.model), undefined)
  })
}

for (const scenario of [
  { name: 'withheld reasoning', thinkingChars: 0, tps: 49.5 },
  { name: 'summarized reasoning', thinkingChars: 40, tps: 54.5 },
  { name: 'fully streamed reasoning', thinkingChars: 400, tps: 99.5 },
]) {
  test(`accounts for ${scenario.name}`, (t) => {
    let now = 0
    t.mock.method(performance, 'now', () => now)
    const tracker = createSpeedTracker()
    tracker.beginRequest()
    now = 1000
    tracker.recordDelta('visible', 4)
    now = 2000
    tracker.recordDelta('thinking', scenario.thinkingChars)
    now = 3000
    tracker.recordDelta('visible', 396)
    tracker.endRequest({ ...outcome, outputTokens: 200, reasoningTokens: 100 })
    assert.deepEqual(tracker.recent(outcome.model), {
      tps: scenario.tps,
      ttftMs: 1000,
    })
  })
}

test('smooths tokens and duration separately and keeps models isolated', (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const tracker = createSpeedTracker()
  tracker.beginRequest()
  now = 100
  tracker.recordDelta('visible', 4)
  now = 1100
  tracker.recordDelta('visible', 4000)
  tracker.endRequest({ ...outcome, outputTokens: 1001 })

  tracker.beginRequest()
  now = 1200
  tracker.recordDelta('visible', 4)
  now = 2200
  tracker.recordDelta('visible', 400)
  tracker.endRequest({ ...outcome, model: 'other/model', outputTokens: 101 })
  assert.equal(tracker.recent('other/model')?.tps, 100)
  assert.equal(tracker.recent(outcome.model)?.tps, 1000)
  assert.equal(tracker.recent('unknown/model'), undefined)

  tracker.beginRequest()
  now = 2400
  tracker.recordDelta('visible', 4)
  now = 2500
  tracker.recordDelta('visible', 40)
  tracker.endRequest({ ...outcome, outputTokens: 11 })
  const weight = 0.5 ** (10 / 4000)
  assert.deepEqual(tracker.recent(outcome.model), {
    tps: ((1000 * weight + 10) / (1000 * weight + 100)) * 1000,
    ttftMs: 200,
  })
})

test('expires idle measurements and clears history and inflight state on reset', (t) => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const tracker = createSpeedTracker()
  tracker.beginRequest()
  now = 1000
  tracker.recordDelta('visible', 4)
  now = 2000
  tracker.recordDelta('visible', 396)
  tracker.endRequest(outcome)
  assert.equal(tracker.recent(outcome.model)?.tps, 99)

  now += 30 * 60 * 1000 + 1
  assert.equal(tracker.recent(outcome.model), undefined)
  tracker.beginRequest()
  now += 1000
  tracker.recordDelta('visible', 4)
  now += 2000
  tracker.recordDelta('visible', 396)
  tracker.endRequest(outcome)
  assert.equal(tracker.recent(outcome.model)?.tps, 49.5)

  tracker.beginRequest()
  now += 1000
  tracker.recordDelta('visible', 4)
  tracker.reset()
  assert.equal(tracker.recent(outcome.model), undefined)
  now += 1000
  assert.equal(tracker.recordDelta('visible', 396), undefined)
  tracker.endRequest(outcome)
  assert.equal(tracker.recent(outcome.model), undefined)
})

test('labels rates as approximate and shows current TTFT while streaming', () => {
  const recent = { tps: 48.4, ttftMs: 920 }
  assert.equal(recentText(recent), '~48 tok/s · TTFT 920ms')
  assert.equal(recentText({ tps: 123, ttftMs: 1230 }), '~120 tok/s · TTFT 1.23s')
  assert.equal(streamingText(recent, { ttftMs: 100 }), '~48 tok/s · TTFT 100ms')
  assert.equal(streamingText(undefined, { ttftMs: 100 }), 'TTFT 100ms')
  assert.equal(recentText(undefined), undefined)
})
