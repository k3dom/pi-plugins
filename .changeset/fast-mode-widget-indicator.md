---
'@pi-plugins/fast-mode': patch
---

Show the active fast-mode indicator as a dim `[fast mode]` widget right above the
editor via `ctx.ui.setWidget`, replacing the previous footer-override hack that
re-rendered pi's built-in footer to append a `• fast` suffix. Pi still only supports
fully replacing the footer, so the widget API is the sanctioned, much simpler way to
surface the state.
