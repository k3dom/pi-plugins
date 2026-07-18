# `@pi-plugins/speed`

A [pi-agent](https://github.com/earendil-works/pi) extension that measures inference
speed per LLM request — tokens per second (TPS) and time to first token (TTFT) — and
shows it on a shared status line above the editor.

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
  percentile is shown only once at least 2 samples lie strictly beyond its rank.
- TPS uses provider-reported token counts, so reasoning/thinking tokens count toward
  throughput even when they are not displayed.
- The measured TTFT is end-to-end from pi's perspective; providers that batch their
  first deltas will look slightly slower than raw API metrics.
