---
'@pi-plugins/fast-mode': patch
---

Render the active `fast` indicator inline on the footer's model line — as a dim `• fast` after the effort level — instead of on a separate, undimmed status row. Reuses pi's built-in footer via a live view over the extension context and appends the suffix flush against the right edge, so it matches the surrounding gray and stays right-aligned across resizes and effort changes.
