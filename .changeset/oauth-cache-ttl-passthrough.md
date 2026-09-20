---
'@pi-plugins/claude-oauth': patch
---

Stop promoting cache markers to a one-hour TTL. Pi 0.86 schedules cache warming from the retention it resolved itself, so the override caused redundant warm requests; retention now follows `PI_CACHE_RETENTION`.
