---
'@pi-plugins/claude-cli': patch
---

Start Claude Code for the next request of a session ahead of time, which saves about
a fifth of a second on every request from the third on. The idle process is stopped
after five minutes and when the session ends.
