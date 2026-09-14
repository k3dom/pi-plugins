---
'@pi-plugins/webfetch': patch
---

Fail timeouts with Effect's own `Cause.TimeoutError` instead of a bespoke
`WebFetchTimeoutError`. The message the model reads back is unchanged.
