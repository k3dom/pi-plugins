---
'@pi-plugins/subagent': patch
---

Fix subagent token/cost usage being lost from the parent session's cumulative
stats. Usage from finished runs (including partial progress on failures) is now
folded back into the next finalized assistant message via `message_end`, so the
footer totals include delegated work. `totalTokens` is left untouched so
context-window estimation stays accurate.
