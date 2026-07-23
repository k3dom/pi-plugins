---
'@pi-plugins/usage': minor
---

Add a status-line widget showing the active provider's session and weekly rate
limits as compact progress bars (e.g. `5h ██░░░ 42% · wk █░░░░ 17%`). The widget
refreshes in the background on session start, model select, and agent end
(throttled to 30s), reuses data fetched by `/usage`, and can be disabled with
`"showWidget": false` in `<agent-dir>/extensions/usage.json`.
