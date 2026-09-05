const MAX_SAMPLES = 1000

// Token-space decay keeps tiny tool calls from flushing the estimate or idle time
// from changing its value.
const HALF_LIFE_TOKENS = 4000
const MIN_WEIGHT = 1e-3
const MAX_SAMPLE_AGE_MS = 30 * 60 * 1000

// Visible and thinking text have different token densities; allow for that when
// distinguishing fully streamed reasoning from a summary.
const REASONING_STREAMED = 0.6
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
  readonly tps: number
  readonly ttftMs: number
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

export function createSpeedTracker() {
  const samples: Sample[] = []
  let inflight: InflightRequest | undefined

  return {
    beginRequest(): void {
      inflight = {
        requestStart: performance.now(),
        firstDeltaChars: 0,
        visibleChars: 0,
        thinkingChars: 0,
      }
    },

    recordDelta(kind: DeltaKind, length: number): FirstToken | undefined {
      const request = inflight
      if (request === undefined || length === 0) {
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
    },

    endRequest(outcome: RequestOutcome): void {
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

      // Billed output includes hidden reasoning. Estimate only the portion that
      // streamed, using this request's visible characters per token.
      const reasoning = Math.min(outcome.reasoningTokens ?? 0, outcome.outputTokens)
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

      // The opening chunk predates the measured interval; remove its share.
      const chars = request.visibleChars + request.thinkingChars
      const tokens =
        ((visible + streamedReasoning) * (chars - request.firstDeltaChars)) / chars
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
      if (samples.length > MAX_SAMPLES) {
        samples.shift()
      }
    },

    recent(model: string): RecentSpeed | undefined {
      const horizon = performance.now() - MAX_SAMPLE_AGE_MS
      const window: { readonly weight: number; readonly sample: Sample }[] = []
      let tokens = 0
      let millis = 0
      let distance = 0
      let totalWeight = 0

      for (let index = samples.length - 1; index >= 0; index--) {
        const sample = samples[index]!
        if (sample.recordedAt < horizon) {
          break
        }
        if (sample.model !== model) {
          continue
        }
        const weight = 0.5 ** (distance / HALF_LIFE_TOKENS)
        if (weight < MIN_WEIGHT) {
          break
        }
        window.push({ weight, sample })
        tokens += weight * sample.tokens
        millis += weight * sample.generationMs
        distance += sample.tokens
        totalWeight += weight
      }

      if (millis === 0) {
        return undefined
      }

      // Weighted median keeps a retried request's backoff from dominating TTFT.
      window.sort((a, b) => a.sample.ttftMs - b.sample.ttftMs)
      let seen = 0
      let ttftMs = 0
      for (const entry of window) {
        seen += entry.weight
        if (seen >= totalWeight / 2) {
          ttftMs = entry.sample.ttftMs
          break
        }
      }

      // Divide the sums, not per-request rates: long responses carry more evidence.
      return { tps: (tokens / millis) * 1000, ttftMs }
    },

    reset(): void {
      samples.length = 0
      inflight = undefined
    },
  }
}
