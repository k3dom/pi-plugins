---
'@pi-plugins/speed': patch
---

Drop the chars-per-token live tok/s heuristic. While a response streams, the status
line now shows only the measured TTFT; tokens/sec is displayed once the request
completes, computed from provider-reported token counts, so the figure is always
real rather than an estimate.
