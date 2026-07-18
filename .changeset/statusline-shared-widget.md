---
'@pi-plugins/fast-mode': patch
'@pi-plugins/speed': patch
---

Render the fast-mode indicator and the speed measurements on one shared status
line above the editor — tokens/sec and TTFT flush left, fast mode flush right —
instead of each plugin stacking its own widget row. Both segments are dimmed
uniformly by the shared status line so they read as a single themed row.
