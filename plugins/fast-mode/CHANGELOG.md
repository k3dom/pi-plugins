# @pi-plugins/fast-mode

## 0.1.1

### Patch Changes

- 4ff4dc1: Import `NodeServices` from its deep subpath instead of the `@effect/platform-node` barrel, so loading the extension no longer eagerly evaluates `NodeRedis` and crashes with `Cannot find module 'ioredis'` when the optional `ioredis` peer dependency is absent.
