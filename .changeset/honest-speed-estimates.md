---
'@pi-plugins/speed': patch
---

Always mark throughput as approximate instead of inferring certainty from agreement
between requests. Remove the confidence estimator and unused Effect service wrapper.
Ignore empty chunks for timing, exclude stale measurements when updating the display,
and only show estimates for the selected model.
