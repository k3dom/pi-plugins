import assert from 'node:assert/strict'
import test from 'node:test'
import { makeSpeedTracker, summarize } from './metrics.ts'

function clock() {
  let value = 0
  return {
    now: () => value,
    set: (next: number) => {
      value = next
    },
  }
}

test('measures TTFT and inter-token throughput for one provider call', () => {
  const time = clock()
  const tracker = makeSpeedTracker(time.now)

  const initial = tracker.start()
  time.set(50)
  assert.equal(tracker.start(), initial)
  time.set(100)
  tracker.markResponse()
  time.set(250)
  tracker.markFirstOutput('text')
  time.set(2_250)
  const sample = tracker.finish({
    provider: 'anthropic',
    model: 'claude',
    stopReason: 'stop',
    outputTokens: 101,
  })

  assert.ok(sample)
  assert.equal(sample.ttftMs, 250)
  assert.equal(sample.responseHeadersMs, 100)
  assert.equal(sample.firstOutputAfterHeadersMs, 150)
  assert.equal(sample.generationMs, 2_000)
  assert.equal(sample.outputTps, 50)
  assert.equal(sample.totalMs, 2_250)
})

test('weights aggregate TPS by generation duration', () => {
  const time = clock()
  const tracker = makeSpeedTracker(time.now)

  tracker.start()
  time.set(250)
  tracker.markFirstOutput('thinking')
  time.set(2_250)
  tracker.finish({
    provider: 'openai',
    model: 'reasoning-model',
    stopReason: 'stop',
    outputTokens: 101,
  })

  time.set(3_000)
  tracker.start()
  time.set(3_500)
  tracker.markFirstOutput('text')
  time.set(4_500)
  tracker.finish({
    provider: 'openai',
    model: 'reasoning-model',
    stopReason: 'toolUse',
    outputTokens: 51,
  })

  assert.deepEqual(summarize(tracker.samples()), {
    calls: 2,
    ttftCalls: 2,
    measuredCalls: 2,
    failedCalls: 0,
    averageTtftMs: 375,
    p50TtftMs: 250,
    p95TtftMs: 500,
    weightedTps: 50,
    measuredTokenIntervals: 150,
    measuredGenerationMs: 3_000,
  })
})

test('does not invent TPS without an inter-token interval', () => {
  const time = clock()
  const tracker = makeSpeedTracker(time.now)

  tracker.start()
  time.set(100)
  tracker.markFirstOutput('text')
  time.set(200)
  const sample = tracker.finish({
    provider: 'test',
    model: 'single-token',
    stopReason: 'stop',
    outputTokens: 1,
  })

  assert.ok(sample)
  assert.equal(sample.ttftMs, 100)
  assert.equal(sample.outputTps, undefined)
  assert.equal(summarize(tracker.samples()).measuredCalls, 0)
})

test('keeps failed calls out of TTFT and TPS aggregates', () => {
  const time = clock()
  const tracker = makeSpeedTracker(time.now)

  tracker.start()
  time.set(100)
  tracker.markFirstOutput('text')
  time.set(500)
  const sample = tracker.finish({
    provider: 'test',
    model: 'failed',
    stopReason: 'error',
    outputTokens: 20,
  })

  assert.ok(sample)
  assert.equal(sample.ttftMs, 100)
  assert.equal(sample.outputTps, undefined)
  assert.deepEqual(summarize(tracker.samples()), {
    calls: 1,
    ttftCalls: 0,
    measuredCalls: 0,
    failedCalls: 1,
    averageTtftMs: undefined,
    p50TtftMs: undefined,
    p95TtftMs: undefined,
    weightedTps: undefined,
    measuredTokenIntervals: 0,
    measuredGenerationMs: 0,
  })
})

test('history reset preserves an active call while session reset clears it', () => {
  const time = clock()
  const tracker = makeSpeedTracker(time.now)

  tracker.start()
  tracker.resetHistory()
  assert.ok(tracker.active())

  tracker.resetSession()
  assert.equal(tracker.active(), undefined)
  assert.deepEqual(tracker.samples(), [])
})
