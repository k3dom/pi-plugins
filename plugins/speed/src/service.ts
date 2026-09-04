import { Array, Context, Effect, Order } from 'effect'

const MAX_SAMPLES = 1000

// Decay in generated tokens, not requests (a burst of tiny tool-call steps would
// flush a good estimate) or wall-clock (the number would drift while idle).
const HALF_LIFE_TOKENS = 4000

const MIN_WEIGHT = 1e-3

// Token-space decay only ages a model while it generates, so a window left behind
// by a model switch or an idle session would otherwise read as current forever.
const MAX_SAMPLE_AGE_MS = 30 * 60 * 1000

// Effective sample size by leverage, not request count: twenty tool-call steps
// beside one long answer are worth barely more than one observation.
const MIN_EFFECTIVE_SAMPLES = 5

// Hysteresis: a single threshold flickered as heavy requests left the window.
const SETTLED_RELATIVE_ERROR = 0.05
const UNSETTLED_RELATIVE_ERROR = 0.15

// Bartlett lags for the serial-correlation term; past two the weights are noise.
const HAC_LAGS = 2

const MAX_LEVERAGE = 0.99

// Share of billed reasoning the streamed thinking must cover to count as streamed
// whole. Chars-per-token varies ~20% between prose, code and JSON; anything under
// this gap is a summary, not measurement noise.
const REASONING_STREAMED = 0.6

// Below this the chunks were flushed from a buffer, not generated.
const MIN_OBSERVED_MS = 2

export type DeltaKind = 'thinking' | 'visible'

interface Sample {
  readonly model: string
  readonly recordedAt: number
  readonly ttftMs: number
  readonly generationMs: number
  readonly tokens: number
}

export interface RecentSpeed {
  readonly model: string
  readonly tps: number
  readonly ttftMs: number
  readonly provisional: boolean
}

export interface FirstToken {
  readonly ttftMs: number
}

export interface RequestOutcome {
  readonly model: string
  readonly stopReason: string
  readonly outputTokens: number
  readonly reasoningTokens: number | undefined
}

interface InflightRequest {
  readonly requestStart: number
  firstTokenAt?: number
  lastDeltaAt?: number
  firstDeltaChars: number
  visibleChars: number
  thinkingChars: number
}

// Tokens and milliseconds are summed separately and divided once, so a request
// counts in proportion to its evidence. Averaging per-request rates would give a
// 30-token tool-call step the same say as a 1500-token answer.
function recentSpeed(
  samples: readonly Sample[],
  settled: boolean,
): RecentSpeed | undefined {
  const latest = samples.at(-1)
  if (latest === undefined) {
    return undefined
  }

  const model = latest.model
  const horizon = latest.recordedAt - MAX_SAMPLE_AGE_MS
  const window: { readonly weight: number; readonly sample: Sample }[] = []
  let tokens = 0
  let millis = 0
  let distance = 0

  for (let index = samples.length - 1; index >= 0; index--) {
    const sample = samples[index]!
    if (sample.model !== model) {
      continue
    }
    if (sample.recordedAt < horizon) {
      break
    }
    const weight = 0.5 ** (distance / HALF_LIFE_TOKENS)
    if (weight < MIN_WEIGHT) {
      break
    }
    window.push({ weight, sample })
    tokens += weight * sample.tokens
    millis += weight * sample.generationMs
    distance += sample.tokens
  }

  const rate = tokens / millis

  // Taylor-linearized variance of the ratio estimator. Each squared residual is
  // divided by its own leverage: a request holding half the window's time is
  // half of what it is compared against and would otherwise fit itself.
  let independent = 0
  let leverageSquares = 0
  const scores: number[] = []
  for (const { weight, sample } of window) {
    const leverage = (weight * sample.generationMs) / millis
    const score = weight * (sample.tokens - rate * sample.generationMs)
    independent += (score * score) / (1 - Math.min(leverage, MAX_LEVERAGE)) ** 2
    leverageSquares += leverage * leverage
    scores.push(score)
  }

  // Requests in one turn share a provider node, queue position and context
  // length, so their residuals move together. Bartlett-weighted lags add that
  // covariance back; the kernel can go negative under alternation, hence the floor.
  let variance = independent
  for (let lag = 1; lag <= HAC_LAGS; lag++) {
    let covariance = 0
    for (let index = 0; index + lag < scores.length; index++) {
      covariance += scores[index]! * scores[index + lag]!
    }
    variance += 2 * (1 - lag / (HAC_LAGS + 1)) * covariance
  }

  const relativeError = Math.sqrt(Math.max(variance, independent)) / tokens
  const effectiveSamples = 1 / leverageSquares

  // Weighted median rather than latest: a retried request charges its whole
  // backoff to TTFT.
  const byTtft = Array.sort(
    window,
    Order.mapInput(
      Order.Number,
      (entry: (typeof window)[number]) => entry.sample.ttftMs,
    ),
  )
  const halfWeight = byTtft.reduce((total, entry) => total + entry.weight, 0) / 2
  let ttftMs = Number.NaN
  let seen = 0
  for (const entry of byTtft) {
    seen += entry.weight
    if (seen >= halfWeight) {
      ttftMs = entry.sample.ttftMs
      break
    }
  }

  return {
    model,
    tps: rate * 1000,
    ttftMs,
    // The sample floor gates unconditionally: a window rebuilt from one request
    // fits it exactly, and its zero residual would hold the latch open on nothing.
    provisional: !(
      effectiveSamples >= MIN_EFFECTIVE_SAMPLES &&
      relativeError <= (settled ? UNSETTLED_RELATIVE_ERROR : SETTLED_RELATIVE_ERROR)
    ),
  }
}

export class SpeedTracker extends Context.Service<SpeedTracker>()(
  '@pi-plugins/speed/SpeedTracker',
  {
    make: Effect.sync(() => {
      const samples: Sample[] = []
      let inflight: InflightRequest | undefined
      let settled = false

      function beginRequest(): void {
        // Compaction and branch summarization stream through this hook too, so
        // one can fire mid-turn and must not re-anchor a request already streaming.
        if (inflight?.firstTokenAt !== undefined) {
          return
        }
        inflight = {
          requestStart: performance.now(),
          firstDeltaChars: 0,
          visibleChars: 0,
          thinkingChars: 0,
        }
      }

      function recordDelta(kind: DeltaKind, length: number): FirstToken | undefined {
        const request = inflight
        if (request === undefined) {
          return undefined
        }

        const now = performance.now()
        if (kind === 'thinking') {
          request.thinkingChars += length
        } else {
          request.visibleChars += length
        }

        if (request.firstTokenAt !== undefined) {
          request.lastDeltaAt = now
          return undefined
        }

        request.firstTokenAt = now
        request.firstDeltaChars = length
        return { ttftMs: now - request.requestStart }
      }

      function endRequest(outcome: RequestOutcome): void {
        const request = inflight
        inflight = undefined

        if (
          request?.firstTokenAt === undefined ||
          request.lastDeltaAt === undefined ||
          outcome.stopReason === 'error' ||
          outcome.stopReason === 'aborted' ||
          outcome.outputTokens <= 0
        ) {
          return
        }

        const generationMs = request.lastDeltaAt - request.firstTokenAt
        if (generationMs < MIN_OBSERVED_MS) {
          return
        }

        const chars = request.visibleChars + request.thinkingChars
        const withinInterval = chars - request.firstDeltaChars
        if (withinInterval <= 0) {
          return
        }

        // Reasoning is billed under `output` whether or not it streams. Withheld
        // or summarized thinking was produced before the first delta, so counting
        // it would credit work no measured interval covers (up to 2x too fast).
        // Only the thinking that streamed belongs in the numerator, converted
        // back to tokens by this request's visible chars-per-token.
        const reasoning = Math.min(
          outcome.reasoningTokens ?? 0,
          outcome.outputTokens,
        )
        const visible = outcome.outputTokens - reasoning
        const density = visible > 0 ? request.visibleChars / visible : 0
        const implied = density > 0 ? request.thinkingChars / density : 0
        const streamedReasoning =
          density <= 0
            ? request.thinkingChars > 0
              ? reasoning
              : 0
            : implied >= reasoning * REASONING_STREAMED
              ? reasoning
              : implied

        // The first delta predates the interval; its share is prorated out by
        // characters since the opening chunk is routinely a fragment.
        const tokens = ((visible + streamedReasoning) * withinInterval) / chars
        if (tokens <= 0) {
          return
        }

        samples.push({
          model: outcome.model,
          recordedAt: request.lastDeltaAt,
          ttftMs: request.firstTokenAt - request.requestStart,
          generationMs,
          tokens,
        })
        if (samples.length >= MAX_SAMPLES * 2) {
          samples.splice(0, samples.length - MAX_SAMPLES)
        }
      }

      function recent(): RecentSpeed | undefined {
        const speed = recentSpeed(samples, settled)
        settled = speed !== undefined && !speed.provisional
        return speed
      }

      function reset(): void {
        samples.length = 0
        inflight = undefined
        settled = false
      }

      return {
        beginRequest,
        recordDelta,
        endRequest,
        recent,
        reset,
      } as const
    }),
  },
) {}
