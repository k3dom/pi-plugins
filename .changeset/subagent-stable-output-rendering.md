---
'@pi-plugins/subagent': patch
---

Prevent long-running subagent tool rows from destabilizing terminal scrolling by
using a static pending indicator instead of an animated spinner. Bound collapsed
result rendering to pi's standard tool-output limits while preserving the full output
when tool results are expanded with Ctrl+O.
