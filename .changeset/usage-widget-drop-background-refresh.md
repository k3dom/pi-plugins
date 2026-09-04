---
'@pi-plugins/usage': patch
---

Drop the widget's background refresh; it hit the usage endpoints' rate limits and
often left the widget empty. It refreshes at most every 30 seconds on session
start, model select and `agent_settled` again.
