# @pi-plugins/speed

## 0.1.4

### Patch Changes

- 82c9023: Measure generation from the first streamed chunk to the last rather than to the end of the
  request, and credit it only with the tokens that arrived inside it.

  The rate was billed tokens over first-chunk-to-message-end, which charged provider teardown
  and pi's own event drain to the model, and counted the first chunk's tokens against an
  interval they predate. Both errors grow as requests get shorter, and an agentic turn is
  mostly short requests: against a simulated 50 tok/s provider with 150ms of teardown, a
  window of tool-call steps read 44.7 tok/s, and 62.3 where the provider batched ~20 tokens
  per chunk. Tokens credited to the window are now `outputTokens * (deltas - 1) / deltas`,
  backing out the first chunk's share from the chunk count, which lands within ~1 tok/s in
  both cases. Simply subtracting one token, the obvious form of this fix, is worse than doing
  nothing under batching: it reads 72.6 tok/s in that same case.

  Responses arriving in a single chunk are dropped rather than timed, as are those whose
  chunks land within 2ms — a buffer flush, not generation. A 1ms floor previously let these
  through as tens of thousands of tokens per second, unbounded in a sum-based estimator.

  TTFT now carries the same decay weights as the rate instead of being an unweighted median
  over roughly ten half-lives, so both figures describe the same stretch of the session.

  Also stop compaction and branch summarization from re-anchoring a request that is already
  streaming. Both stream through the same provider hook without surfacing as assistant
  messages, so one firing mid-turn silently discarded that turn's measurement.

- 82c9023: Mark the rate provisional based on how much the recent requests disagree rather than on how
  many tokens have been seen, and drop the decimal place from tok/s.

  The `~` cleared once the window held a half-life of tokens, which measures volume of
  evidence, not precision: two large responses cleared the bar while saying nothing about the
  spread between requests, and an erratic provider cleared it _sooner_ than a steady one
  because its slow requests filled the window faster. It now tracks the Taylor-linearized
  standard error of the ratio estimator and clears at 5%, with Kish's effective sample size
  standing in for `n` in the `n/(n-1)` correction — which also stops a window carried by one
  heavy request, where the residual is near zero by construction, from reading as a perfect
  measurement. Settling is sticky until the error passes 15%, since a single threshold made
  the mark flicker ~20 times a session.

  tok/s is now whole tokens. The standard error across requests runs to several tokens per
  second, so the tenths digit was showing noise at roughly 17x the precision on offer.

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
