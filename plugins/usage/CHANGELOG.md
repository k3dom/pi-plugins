# @pi-plugins/usage

## 0.4.0

### Minor Changes

- 6ce597c: Keep the usage widget current while a session sits idle: it now repaints every
  minute and refetches every 5 minutes, backing off when a provider keeps failing.
  Refreshes also moved from `agent_end` to `agent_settled` and skip the 30s floor
  there, so the numbers shown right after a turn are the post-turn ones.

## 0.3.2

### Patch Changes

- fc580c6: Unify how plugins run Effects at pi's promise boundary through shared
  `runTool`/`runHandler` helpers. Cancelled tools now report `Operation aborted`
  like pi's builtins, and failures surface their own message instead of a
  pretty-printed `Cause`.

## 0.3.1

### Patch Changes

- cb59f15: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.103 and Pi 0.83.0 compatibility updates.

## 0.3.0

### Minor Changes

- db02f56: Show when each rate-limit window resets in the status-line widget, as a compact
  single-unit countdown after the percentage
  (`5h ██░░░ 42% (2h) · wk █░░░░ 17% (4d)`).

## 0.2.0

### Minor Changes

- f12639f: Add a status-line widget showing the active provider's session and weekly rate
  limits as compact progress bars (e.g. `5h ██░░░ 42% · wk █░░░░ 17%`). The widget
  refreshes in the background on session start, model select, and agent end
  (throttled to 30s), reuses data fetched by `/usage`, and can be disabled with
  `"showWidget": false` in `<agent-dir>/extensions/usage.json`.

## 0.1.3

### Patch Changes

- 17b573d: Group provider sections by severity into a single info and a single warning message, since the UI only shows one message per severity and all-success runs previously displayed only the last provider

## 0.1.2

### Patch Changes

- 9f4e439: Emit one notification per provider so successful providers report as info and failed providers as warnings, instead of a single combined message

## 0.1.1

### Patch Changes

- 1687714: Restore Pi 0.80.10 compatibility by using the current model-registry credential APIs
  and removing the retired bare GPT-5.6 alias from fast-mode defaults.
