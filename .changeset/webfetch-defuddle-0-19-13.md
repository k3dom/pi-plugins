---
'@pi-plugins/webfetch': patch
---

Depend on defuddle 0.19.13, which fixes an XSS through an unescaped `<title>` inside
`<math>` (GHSA-w8hh-2cpq-9whp).
