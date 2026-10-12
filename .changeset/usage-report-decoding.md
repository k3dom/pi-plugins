---
'@pi-plugins/usage': patch
---

Accept epoch-second reset times in every Claude usage window, not only in the
unified limits, instead of failing the Claude section. A malformed `usage-report`
entry in a session now renders nothing instead of breaking the renderer.
