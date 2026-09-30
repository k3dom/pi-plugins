---
'@pi-plugins/websearch': minor
---

Declare an output schema for `web_search` and return the results as structured
content. Codemode scripts now receive `{ results: [{ title, url, content, publishedAt? }] }`
instead of the Markdown text.
