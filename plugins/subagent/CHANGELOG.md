# @pi-plugins/subagent

## 0.1.5

### Patch Changes

- a00078c: Surface the latest thinking summary as live status while a subagent is running.
  OpenAI/codex models emit no interim assistant text between tool calls (their
  first text block arrives only with the final message), so the UI previously
  stayed stuck on the `(running...)` fallback for the entire run.

## 0.1.4

### Patch Changes

- 7554143: Prevent long-running subagent tool rows from destabilizing terminal scrolling by
  using a static pending indicator instead of an animated spinner. Bound collapsed
  result rendering to pi's standard tool-output limits while preserving the full output
  when tool results are expanded with Ctrl+O.

## 0.1.3

### Patch Changes

- fb4d4ce: Fix spurious auto-compaction in parent sessions caused by folding subagent token
  usage into the next assistant message. pi's silent-overflow heuristic
  (`isContextOverflow`) compares `usage.input + usage.cacheRead` of the last assistant
  message against the model's context window; subagents accumulate large cumulative
  cacheRead across their turns, so sessions that spawned several subagents were
  compacted at a fraction of the real context usage. Only `cost.total` is folded back
  into the parent session now — token counts remain per-request accurate, and per-run
  subagent token stats stay visible on each tool call.

## 0.1.2

### Patch Changes

- 27b05a4: Fix subagent token/cost usage being lost from the parent session's
  cumulative stats. Usage from finished runs (including partial progress on failures)
  is now folded back into the next finalized assistant message via `message_end`, so
  the footer totals include delegated work. `totalTokens` is left untouched so
  context-window estimation stays accurate.

## 0.1.1

### Patch Changes

- b1486c1: Model subagent run failures as typed errors in the Effect error channel
  instead of folding them into the success value. `runSubagent` now succeeds only
  with the final run snapshot and fails with self-describing tagged errors
  (`SubagentStopError`, `SubagentExitError`, `SubagentNoOutputError`, or the
  underlying `PlatformError`), which the tool maps onto failed tool calls in a single
  generic handler at the usage site.
