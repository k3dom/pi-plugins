---
'@pi-plugins/claude-cli': patch
---

Start Claude Code only when a request is made, instead of keeping an idle process ready
for the next request of each session. Each request after the first now takes about a
fifth of a second longer to start, in exchange for the CPU and about 200 MiB of memory
that each idle process held.
