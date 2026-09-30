---
'@pi-plugins/subagent': minor
---

Report subagent token usage and cost on the tool result, so pi counts both toward the
session totals. This replaces the `message_end` hook that added only the cost to the
next assistant message. Tool results in sessions recorded with earlier versions no
longer show the subagent cost.
