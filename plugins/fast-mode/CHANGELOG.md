# @pi-plugins/fast-mode

## 0.1.8

### Patch Changes

- 6234a89: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.100 and Pi 0.81.1 compatibility updates.

## 0.1.7

### Patch Changes

- 4a50495: Render the fast-mode indicator and the speed measurements on one shared status
  line above the editor — tokens/sec and TTFT flush left, fast mode flush right —
  instead of each plugin stacking its own widget row. Both segments are dimmed
  uniformly by the shared status line so they read as a single themed row.

## 0.1.6

### Patch Changes

- 4278f53: Show the active fast-mode indicator as a dim `[fast mode]` widget right above the
  editor via `ctx.ui.setWidget`, replacing the previous footer-override hack that
  re-rendered pi's built-in footer to append a `• fast` suffix. Pi still only supports
  fully replacing the footer, so the widget API is the sanctioned, much simpler way to
  surface the state.

## 0.1.5

### Patch Changes

- 321b296: Prevent the active fast-mode footer from crashing on pi 0.80.10 by adapting the
  footer's model runtime access to the extension model registry.

## 0.1.4

### Patch Changes

- 1687714: Restore Pi 0.80.10 compatibility by using the current model-registry credential APIs
  and removing the retired bare GPT-5.6 alias from fast-mode defaults.

## 0.1.3

### Patch Changes

- bbfcedf: Enable fast mode by default for the GPT-5.6 Sol, Terra, and Luna models on OpenAI and
  OpenAI Codex, including OpenAI's `gpt-5.6` alias.

## 0.1.2

### Patch Changes

- e82b1c2: Render the active `fast` indicator inline on the footer's model line — as
  a dim `• fast` after the effort level — instead of on a separate, undimmed status
  row. Reuses pi's built-in footer via a live view over the extension context and
  appends the suffix flush against the right edge, so it matches the surrounding gray
  and stays right-aligned across resizes and effort changes.

## 0.1.1

### Patch Changes

- 4ff4dc1: Import `NodeServices` from its deep subpath instead of the
  `@effect/platform-node` barrel, so loading the extension no longer eagerly
  evaluates `NodeRedis` and crashes with `Cannot find module 'ioredis'` when the
  optional `ioredis` peer dependency is absent.
