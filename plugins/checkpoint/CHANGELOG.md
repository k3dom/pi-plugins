# @pi-plugins/checkpoint

## 0.1.3

### Patch Changes

- fc580c6: Unify how plugins run Effects at pi's promise boundary through shared
  `runTool`/`runHandler` helpers. Cancelled tools now report `Operation aborted`
  like pi's builtins, and failures surface their own message instead of a
  pretty-printed `Cause`.

## 0.1.2

### Patch Changes

- cb59f15: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.103 and Pi 0.83.0 compatibility updates.

## 0.1.1

### Patch Changes

- 6234a89: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.100 and Pi 0.81.1 compatibility updates.
