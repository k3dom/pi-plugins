# @pi-plugins/speed

## 0.1.3

### Patch Changes

- 579775a: Show throughput over a trailing token window instead of the last request alone. One
  measurement is taken per provider request, so an agentic turn produces many wildly
  different ones — a 30-token tool-call step is mostly fixed per-request overhead, a
  1500-token answer is mostly real generation — and displaying the latest made the
  status line swing by 30-40% within a single turn. The figure is now a token-weighted
  ratio of summed tokens to summed milliseconds over the recent samples for the model
  that answered last, decayed with a 4000-token half-life, so it sharpens over a session
  while still tracking a genuine provider slowdown. The TTFT beside it is the median of
  the same window rather than the last request, which keeps a retried request from
  charging its whole backoff to the display.

  Also reset samples on `session_start`: they were kept in extension-level state and
  leaked across `/new`, `/resume`, and forks, contrary to the documented behavior.

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
