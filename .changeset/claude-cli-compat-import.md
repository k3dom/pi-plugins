---
'@pi-plugins/claude-cli': patch
---

Load in pi again. Since 0.2.0 the plugin imported a part of pi-ai that pi does not
provide to extensions, so pi failed to load it and offered no `claude-cli` models.
