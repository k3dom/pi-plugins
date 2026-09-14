---
'@pi-plugins/checkpoint': patch
'@pi-plugins/claude-oauth': patch
'@pi-plugins/fast-mode': patch
'@pi-plugins/speed': patch
'@pi-plugins/subagent': patch
'@pi-plugins/usage': patch
'@pi-plugins/webfetch': patch
'@pi-plugins/websearch': patch
---

Bundle Effect into the extension instead of depending on it at runtime. npm could
resolve two incompatible Effect versions into the install tree, which either failed
to load the extension or warned `Ignoring invalid <name> config: TypeError` on every
startup.
