---
'@pi-plugins/usage': patch
---

Fix crash when a usage API request times out: errors without a string `message` (e.g. `Cause.TimeoutError`) failed `UsageServiceError`'s schema validation.
