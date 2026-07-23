# @pi-plugins/usage

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
