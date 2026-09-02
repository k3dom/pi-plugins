---
'@pi-plugins/usage': minor
---

Add GLM Coding Plan (Z.ai / Zhipu) usage reporting: `/usage` gains a GLM section
with the 5h and weekly quota windows (percent, reset time, credits used), and the
status-line widget shows `5h`/`wk` bars while a `zai` or `zai-coding-cn` model is
active. Credentials are read from the API key stored for the `zai` provider
(`zai-coding-cn` for the open.bigmodel.cn China platform); `/usage` reports the
platform you have a key for, preferring the global one.
