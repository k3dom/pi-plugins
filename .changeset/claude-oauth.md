---
'@pi-plugins/claude-oauth': minor
---

Add `claude-oauth` plugin: makes pi's Anthropic OAuth requests match the current
Claude Code client so OAuth login works correctly — identity and Stainless
headers via `registerProvider`, the `x-anthropic-billing-header` system block,
`metadata.user_id`, and the `cch` request-integrity value patched onto the
serialized body via a global fetch wrapper.
