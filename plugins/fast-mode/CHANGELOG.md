# @pi-plugins/fast-mode

## 0.1.2

### Patch Changes

- e82b1c2: Render the active `fast` indicator inline on the footer's model line — as a dim `• fast` after the effort level — instead of on a separate, undimmed status row. Reuses pi's built-in footer via a live view over the extension context and appends the suffix flush against the right edge, so it matches the surrounding gray and stays right-aligned across resizes and effort changes.

## 0.1.1

### Patch Changes

- 4ff4dc1: Import `NodeServices` from its deep subpath instead of the `@effect/platform-node` barrel, so loading the extension no longer eagerly evaluates `NodeRedis` and crashes with `Cannot find module 'ioredis'` when the optional `ioredis` peer dependency is absent.
