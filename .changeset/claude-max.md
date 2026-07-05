---
'@pi-plugins/claude-max': minor
---

Add `claude-max` plugin: reshapes pi's Anthropic OAuth (Claude Pro/Max
subscription) requests to match the current Claude Code fingerprint — identity
and Stainless headers via `registerProvider`, the `x-anthropic-billing-header`
system block, `metadata.user_id` cloaking, and the `cch` attestation patched
onto the serialized body via a global fetch wrapper.
