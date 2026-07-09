---
'@pi-plugins/subagent': patch
---

Fix spurious auto-compaction in parent sessions caused by folding subagent token
usage into the next assistant message. pi's silent-overflow heuristic
(`isContextOverflow`) compares `usage.input + usage.cacheRead` of the last assistant
message against the model's context window; subagents accumulate large cumulative
cacheRead across their turns, so sessions that spawned several subagents were
compacted at a fraction of the real context usage. Only `cost.total` is folded back
into the parent session now — token counts remain per-request accurate, and per-run
subagent token stats stay visible on each tool call.
