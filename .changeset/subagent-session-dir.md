---
'@pi-plugins/subagent': minor
---

Honour `PI_SUBAGENT_SESSION_DIR` as the directory subagent sessions are written
to. Unset, they land in `sessions/subagents/` under pi's agent directory as
before. A harness that archives a run can now keep the delegated sessions beside
the parent's instead of losing them to the global directory.
