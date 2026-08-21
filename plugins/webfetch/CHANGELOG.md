# @pi-plugins/webfetch

## 0.2.4

### Patch Changes

- fc580c6: Unify how plugins run Effects at pi's promise boundary through shared
  `runTool`/`runHandler` helpers. Cancelled tools now report `Operation aborted`
  like pi's builtins, and failures surface their own message instead of a
  pretty-printed `Cause`.
- 902b667: Fix a `web_fetch` timeout killing the agent's next turn (earendil-works/pi#7660):
  timeouts now fail with a real error message instead of an `undefined` one.

## 0.2.3

### Patch Changes

- cdbb644: Stop pages that carry more than one schema.org `url`, such as dblp search
  results, from printing a stack trace to stderr while converting to Markdown.

## 0.2.2

### Patch Changes

- cb59f15: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.103 and Pi 0.83.0 compatibility updates.
- 78917d2: Cap the collapsed result preview at five wrapped terminal rows. It previously showed
  ten source lines, which for a fetched page is ten paragraphs and wrapped to a wall of
  text.

## 0.2.1

### Patch Changes

- 6234a89: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.100 and Pi 0.81.1 compatibility updates.

## 0.2.0

### Minor Changes

- 6773b0a: Expose WebFetch parameter defaults through the tool schema while
  simplifying parameter descriptions.

## 0.1.1

### Patch Changes

- 6eaf295: Validate automated npm publishing via Changesets and OIDC trusted
  publishing.
