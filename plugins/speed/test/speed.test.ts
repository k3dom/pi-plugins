import { assert, it } from '@effect/vitest'
import { assertEquals, assertNone, assertSome } from '@effect/vitest/utils'
import { Duration, Effect, Option } from 'effect'
import { TestClock } from 'effect/testing'
import * as Render from '../src/render'
import * as Tracker from '../src/tracker'

const outcome = {
  model: 'provider/model',
  stopReason: 'stop',
  outputTokens: 100,
  reasoningTokens: undefined,
}

it.effect(
  'times nonempty chunks, excludes the opening chunk and ignores teardown',
  () =>
    Effect.gen(function* () {
      const tracker = yield* Tracker.Tracker.make
      yield* tracker.beginRequest()
      yield* TestClock.adjust('100 millis')
      assertNone(yield* tracker.recordDelta('thinking', 0))
      yield* TestClock.adjust('900 millis')
      assertEquals(
        yield* tracker.recordDelta('visible', 4),
        Option.some(Duration.seconds(1)),
      )
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 396)
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 0)
      yield* TestClock.adjust('2 seconds')
      yield* tracker.endRequest(outcome)
      assertEquals(
        yield* tracker.recent(outcome.model),
        Option.some({ tps: 99, ttft: Duration.seconds(1) }),
      )
    }),
)

it.effect.each([
  {
    name: 'error',
    stopReason: 'error',
    outputTokens: 100,
    duration: Duration.seconds(1),
  },
  {
    name: 'abort',
    stopReason: 'aborted',
    outputTokens: 100,
    duration: Duration.seconds(1),
  },
  {
    name: 'missing usage',
    stopReason: 'stop',
    outputTokens: 0,
    duration: Duration.seconds(1),
  },
  {
    name: 'buffer flush',
    stopReason: 'stop',
    outputTokens: 100,
    duration: Duration.millis(1),
  },
  {
    name: 'single chunk',
    stopReason: 'stop',
    outputTokens: 100,
    duration: undefined,
  },
])('does not report throughput for $name', (scenario) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker.Tracker.make
    yield* tracker.beginRequest()
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('visible', 4)
    if (scenario.duration !== undefined) {
      yield* TestClock.adjust(scenario.duration)
      yield* tracker.recordDelta('visible', 396)
    }
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('thinking', 0)
    yield* tracker.endRequest({ ...outcome, ...scenario })
    assertNone(yield* tracker.recent(outcome.model))
  }),
)

it.effect.each([
  { name: 'withheld reasoning', thinkingChars: 0, tps: 49.5 },
  { name: 'summarized reasoning', thinkingChars: 40, tps: 54.5 },
  { name: 'fully streamed reasoning', thinkingChars: 400, tps: 99.5 },
])('accounts for $name', ({ thinkingChars, tps }) =>
  Effect.gen(function* () {
    const tracker = yield* Tracker.Tracker.make
    yield* tracker.beginRequest()
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('visible', 4)
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('thinking', thinkingChars)
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('visible', 396)
    yield* tracker.endRequest({
      ...outcome,
      outputTokens: 200,
      reasoningTokens: 100,
    })
    assertEquals(
      yield* tracker.recent(outcome.model),
      Option.some({ tps, ttft: Duration.seconds(1) }),
    )
  }),
)

it.effect('smooths tokens and duration separately and keeps models isolated', () =>
  Effect.gen(function* () {
    const tracker = yield* Tracker.Tracker.make
    yield* tracker.beginRequest()
    yield* TestClock.adjust('100 millis')
    yield* tracker.recordDelta('visible', 4)
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('visible', 4000)
    yield* tracker.endRequest({ ...outcome, outputTokens: 1001 })

    yield* tracker.beginRequest()
    yield* TestClock.adjust('100 millis')
    yield* tracker.recordDelta('visible', 4)
    yield* TestClock.adjust('1 second')
    yield* tracker.recordDelta('visible', 400)
    yield* tracker.endRequest({
      ...outcome,
      model: 'other/model',
      outputTokens: 101,
    })
    assertSome(
      Option.map(yield* tracker.recent('other/model'), ({ tps }) => tps),
      100,
    )
    assertSome(
      Option.map(yield* tracker.recent(outcome.model), ({ tps }) => tps),
      1000,
    )
    assertNone(yield* tracker.recent('unknown/model'))

    yield* tracker.beginRequest()
    yield* TestClock.adjust('200 millis')
    yield* tracker.recordDelta('visible', 4)
    yield* TestClock.adjust('100 millis')
    yield* tracker.recordDelta('visible', 40)
    yield* tracker.endRequest({ ...outcome, outputTokens: 11 })
    const weight = 0.5 ** (10 / 4000)
    assertEquals(
      yield* tracker.recent(outcome.model),
      Option.some({
        tps: ((1000 * weight + 10) / (1000 * weight + 100)) * 1000,
        ttft: Duration.millis(200),
      }),
    )
  }),
)

it.effect(
  'expires idle measurements and clears history and inflight state on reset',
  () =>
    Effect.gen(function* () {
      const tracker = yield* Tracker.Tracker.make
      yield* tracker.beginRequest()
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 4)
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 396)
      yield* tracker.endRequest(outcome)
      assertSome(
        Option.map(yield* tracker.recent(outcome.model), ({ tps }) => tps),
        99,
      )

      yield* TestClock.adjust(Duration.sum(Duration.minutes(30), Duration.millis(1)))
      assertNone(yield* tracker.recent(outcome.model))
      yield* tracker.beginRequest()
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 4)
      yield* TestClock.adjust('2 seconds')
      yield* tracker.recordDelta('visible', 396)
      yield* tracker.endRequest(outcome)
      assertSome(
        Option.map(yield* tracker.recent(outcome.model), ({ tps }) => tps),
        49.5,
      )

      yield* tracker.beginRequest()
      yield* TestClock.adjust('1 second')
      yield* tracker.recordDelta('visible', 4)
      yield* tracker.reset()
      assertNone(yield* tracker.recent(outcome.model))
      yield* TestClock.adjust('1 second')
      assertNone(yield* tracker.recordDelta('visible', 396))
      yield* tracker.endRequest(outcome)
      assertNone(yield* tracker.recent(outcome.model))
    }),
)

it('labels rates as approximate and shows current TTFT while streaming', () => {
  const recent = Option.some({ tps: 48.4, ttft: Duration.millis(920) })
  assertSome(Render.recentText(recent), '~48 tok/s · TTFT 920ms')
  assertSome(
    Render.recentText(Option.some({ tps: 123, ttft: Duration.millis(1230) })),
    '~120 tok/s · TTFT 1.23s',
  )
  assert.strictEqual(
    Render.streamingText(recent, Duration.millis(100)),
    '~48 tok/s · TTFT 100ms',
  )
  assert.strictEqual(
    Render.streamingText(Option.none(), Duration.millis(100)),
    'TTFT 100ms',
  )
  assertNone(Render.recentText(Option.none()))
})
