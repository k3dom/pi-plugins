# @pi-plugins/speed

## 0.1.2

### Patch Changes

- 6590e51: Drop the chars-per-token live tok/s heuristic. While a response streams, the status
  line now shows only the measured TTFT; tokens/sec is displayed once the request
  completes, computed from provider-reported token counts, so the figure is always
  real rather than an estimate.

## 0.1.1

### Patch Changes

- 4a50495: Render the fast-mode indicator and the speed measurements on one shared status
  line above the editor — tokens/sec and TTFT flush left, fast mode flush right —
  instead of each plugin stacking its own widget row. Both segments are dimmed
  uniformly by the shared status line so they read as a single themed row.
