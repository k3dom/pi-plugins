---
'@pi-plugins/usage': minor
---

Add GLM Coding Plan (Z.ai / Zhipu) usage reporting: `/usage` gains a GLM section
with the 5h and weekly quota windows (percent, reset time, credits used), and the
status-line widget shows `5h`/`wk` bars while a `zai` or `zai-coding-cn` model is
active. It authenticates with the API key pi resolves for the `zai` provider
(`zai-coding-cn` for the open.bigmodel.cn China platform), whether from `/login` or
the `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` environment variables; `/usage` reports
the platform you have a key for, preferring the global one.
