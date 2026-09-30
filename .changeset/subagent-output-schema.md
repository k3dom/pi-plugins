---
'@pi-plugins/subagent': minor
---

Declare an output schema for `subagent` and return the run as structured content.
Codemode scripts now receive `{ output, sessionId?, model?, toolCalls, durationMs, usage }`
with the full, untruncated final response. Failed runs still reject with the error
text.
