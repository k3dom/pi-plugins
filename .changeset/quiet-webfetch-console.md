---
'@pi-plugins/webfetch': patch
---

Stop defuddle's console output from writing over pi's TUI while a page converts to
Markdown, and return an empty or plain text body served as HTML as is instead of
failing with "Failed to convert HTML to Markdown".
