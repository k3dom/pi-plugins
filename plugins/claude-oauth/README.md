# @pi-plugins/claude-oauth

Makes pi's Anthropic OAuth requests match the current Claude Code client so
OAuth login works correctly. When pi authenticates with a Claude account instead
of an API key, Anthropic expects the request to look the way Claude Code's own
requests do; this plugin lines them up — the identity and Stainless headers, the
beta set, the `x-anthropic-billing-header` system block, `metadata.user_id`, and
the `cch` request-integrity value computed over the serialized body.
