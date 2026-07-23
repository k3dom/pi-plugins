---
'@pi-plugins/claude-oauth': minor
'@pi-plugins/subagent': patch
---

Apply Anthropic's one-hour cache TTL to the existing cache breakpoints in Claude
subscription requests handled by `claude-oauth`, without changing API-key requests
or requiring the process-wide `PI_CACHE_RETENTION` setting. Subagents now override
`PI_CACHE_RETENTION` to `short` in their inherited environment so spawned pi
instances retain the standard cache duration, including when the OAuth plugin is
loaded in the child.
