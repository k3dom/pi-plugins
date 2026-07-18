# `@pi-plugins/speed`

A [pi-agent](https://github.com/earendil-works/pi) extension that measures the speed
of each model response and keeps the latest result in pi's status line. It reports
provider output tokens per second (TPS), time to first token (TTFT), and a small
per-model session summary.

## Install

```bash
pi install npm:@pi-plugins/speed
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/speed
```

For local development, build and load it straight from this directory:

```bash
pnpm --filter @pi-plugins/speed build
pi -e ./plugins/speed
```

## Usage

The status line updates at three points during every provider call:

```text
speed: waiting for first token…
speed: TTFT 842ms · streaming
speed: 51.7 tok/s · TTFT 842ms
```

Use `/speed` for details and aggregate statistics collected since the session was
loaded:

```text
/speed          # last call and session summary
/speed status   # same as /speed
/speed recent   # ten most recent provider calls
/speed reset    # clear collected history
```

Example report:

```text
Last call — #3 anthropic/claude-sonnet-4-5
  TTFT 842ms · TPS 51.7 tok/s · total 5.45s
  238 output tokens · generation 4.60s · tool use
  response headers 611ms · headers to first output 231ms

For anthropic/claude-sonnet-4-5 since session load
  3 calls · 3 with TPS
  TTFT (3 calls) avg 790ms · p50 761ms · p95 842ms
  Weighted TPS 49.8 tok/s · 711 measured token intervals
```

Each assistant response is measured separately. If the model calls tools and then
continues, the responses before and after the tools are separate samples and tool
execution time is excluded.

## Measurement

The extension uses pi's provider and streaming lifecycle events:

1. `before_provider_request` starts the monotonic timer immediately before the
   logical provider request.
2. The first non-empty text, thinking, or tool-call delta establishes TTFT.
3. The assistant `message_end` event ends the generation interval and supplies the
   provider-reported output-token count.

The reported metrics are:

```text
TTFT = first streamed output - provider request start
TPS  = (output tokens - 1) / (message end - first streamed output)
```

The first token is accounted for by TTFT, so TPS measures the remaining inter-token
intervals. Aggregate TPS is weighted by generation duration
(`sum(token intervals) / sum(duration)`), not an average of per-call rates. Aggregate
statistics in `/speed` are scoped to the model used by the latest call.

## Notes

- Metrics are client-observed. Pi's extension API does not expose the provider's
  internal queue time, inference start, exact socket-write time, or individual HTTP
  retries. Other extension handlers that run later in the provider or streaming event
  pipelines can also add a small amount of latency.
- Provider SDK retries that happen inside one logical request are included in TTFT.
- Output chunks are not tokens. TPS therefore uses final `usage.output` rather than
  estimating tokens from streamed text.
- `usage.output` includes reasoning tokens when the provider reports them. Providers
  that generate hidden reasoning before their first visible or summarized output can
  therefore make TPS differ from visible-text throughput.
- Calls with only one output token have no inter-token interval. Calls without enough
  streamed output or provider usage still report available latency, but show TPS as
  `n/a`.
- Custom providers must forward pi's provider payload callback for
  `before_provider_request` to fire. Calls that bypass that hook cannot be timed.
- The plugin is built and tested against pi 0.80.3. Older versions that lack the
  provider lifecycle hooks cannot collect all metrics.
- History is in memory and starts fresh when a session is loaded or the extension is
  reloaded.
