---
'@pi-plugins/fast-mode': patch
---

Import `NodeServices` from its deep subpath instead of the `@effect/platform-node` barrel, so loading the extension no longer eagerly evaluates `NodeRedis` and crashes with `Cannot find module 'ioredis'` when the optional `ioredis` peer dependency is absent.
