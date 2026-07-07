# @pi-plugins/subagent

## 0.1.1

### Patch Changes

- b1486c1: Model subagent run failures as typed errors in the Effect error channel instead
  of folding them into the success value. `runSubagent` now succeeds only with the
  final run snapshot and fails with self-describing tagged errors
  (`SubagentStopError`, `SubagentExitError`, `SubagentNoOutputError`, or the
  underlying `PlatformError`), which the tool maps onto failed tool calls in a
  single generic handler at the usage site.
