---
'@pi-plugins/usage': patch
---

Drop the widget's background refresh loops. The 5-minute poll, per-minute
repaint refetch and floor-less `agent_settled` refresh added in 0.4.0 pushed the
usage endpoints' rate limits hard enough, especially across several concurrent
sessions, that fetches failed and the widget frequently showed nothing at all.
The widget is back to refreshing at most every 30 seconds on session start,
model select and `agent_settled`.
