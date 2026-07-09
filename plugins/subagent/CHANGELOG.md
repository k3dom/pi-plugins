# @pi-plugins/subagent

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
