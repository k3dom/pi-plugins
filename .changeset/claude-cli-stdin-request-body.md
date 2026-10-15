---
'@pi-plugins/claude-cli': patch
---

Lift the 2 MiB limit on the session history. The conversation now reaches Claude Code
over stdin instead of through a settings file, so long sessions and sessions with
screenshots no longer fail with `Settings file exceeds the 2MiB limit`. Prompt caching
works as before.
