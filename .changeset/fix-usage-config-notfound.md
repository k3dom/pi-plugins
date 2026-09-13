---
'@pi-plugins/usage': patch
---

Fix a twice-per-startup "Ignoring invalid usage config: TypeError: undefined is not an object" warning under pi's Bun runtime: the NotFound catch predicate now tolerates error objects without a reason field and also accepts an unwrapped SystemError whose `_tag` is 'NotFound'.
