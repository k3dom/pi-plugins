---
'@pi-plugins/subagent': patch
---

Surface the latest thinking summary as live status while a subagent is running.
OpenAI/codex models emit no interim assistant text between tool calls (their
first text block arrives only with the final message), so the UI previously
stayed stuck on the `(running...)` fallback for the entire run.
