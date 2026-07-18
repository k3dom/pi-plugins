# `@pi-plugins/speed`

A [pi-agent](https://github.com/earendil-works/pi) extension that measures inference
speed per LLM request — tokens per second (TPS) and time to first token (TTFT) — and
shows it in a widget line above the editor.

## How it measures

Each provider request is timed through pi's extension lifecycle events:

- **TTFT** — from `before_provider_request` (payload handed to the provider) to the
  first streamed delta (text, thinking, or tool-call). This includes network latency
  and prompt processing.
- **TPS** — provider-reported output tokens (`usage.output`, which includes reasoning
  tokens) divided by the time from the first streamed delta to the end of the
  message.

While a response is streaming, a live estimate (`~42.0 tok/s`) derived from streamed
characters (≈4 chars/token) is shown; it is replaced by the exact provider-reported
figure when the message completes. Aborted and failed requests are discarded.

The measurement is rendered as a dim widget line above the editor, e.g.
`48.3 tok/s · TTFT 920ms`.

## Install

```bash
pi install npm:@pi-plugins/speed
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/speed
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/speed
```

## Usage

```text
/speed   # session report: last request + per-model aggregates & quantiles
```

Example report:

```text
Inference speed — this session (14 requests)

Last request  anthropic/claude-opus-4-6
  48.3 tok/s · TTFT 920ms · 1.2k tok in 25.6s

Per model
  anthropic/claude-opus-4-6    12 req · 45.1 tok/s · 14.8k tok
    TTFT   p50 1.02s · max 2.31s
    tok/s  p50 45.8 · min 39.2
  openai/gpt-5.5                2 req · 88.7 tok/s · 3.1k tok
    TTFT   max 690ms
    tok/s  min 86.1
```

## Notes

- Samples are kept per session (up to 1000) and reset when the session ends.
- Quantiles are exact (nearest-rank over the raw samples, per model) and gated: a
  percentile is shown only once at least 2 samples lie strictly beyond its rank (p50
  needs ≥ 4 requests, p95 ≥ 40); below that only the worst observed value is shown,
  since small-sample percentiles are just the (near-)max relabeled. At session-scale
  sample counts p99 would never clear that bar, so it is not reported — `max`/`min`
  covers the extreme tail.
- Percentiles walk toward the _worse_ tail: high for TTFT, low for tok/s (so "p95
  42.0" under tok/s means 95% of requests ran at ≥ 42.0 tok/s).
- TPS uses provider-reported token counts, so reasoning/thinking tokens count toward
  throughput even when they are not displayed.
- The measured TTFT is end-to-end from pi's perspective; providers that batch their
  first deltas will look slightly slower than raw API metrics.
