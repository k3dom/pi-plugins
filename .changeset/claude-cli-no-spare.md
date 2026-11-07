---
'@pi-plugins/claude-cli': patch
---

Start Claude Code only when a request is made, instead of keeping an idle process ready
for the next request of each session. From the third request of a session on, a
response now starts about a fifth of a second later, in exchange for the CPU and about
200 MiB of memory that each idle process held.
