# `@pi-plugins/fast-mode`

A [pi-agent](https://github.com/earendil-works/pi) extension that requests a
provider's fast (priority) service tier for configured models — faster inference at a
higher token cost.

Fast mode is a per-model opt-in: you decide which `provider/model-id` pairs it
applies to, and a single session toggle turns it on and off. Requests for any other
model are left untouched.

## Supported providers

| Provider       | Mechanism                          |
| -------------- | ---------------------------------- |
| `openai`       | `service_tier: "priority"` payload |
| `openai-codex` | `service_tier: "priority"` payload |

## Install

```bash
pi install npm:@pi-plugins/fast-mode
```

For one-off testing without adding it to settings:

```bash
pi -e npm:@pi-plugins/fast-mode
```

## Usage

```text
/fast          # toggle fast mode for this session
/fast on       # enable
/fast off      # disable
/fast status   # show the current state and why it is (in)active
```

Start a session with fast mode already enabled:

```bash
pi --fast
```

While fast mode is on and the current model is configured for it, a `fast` indicator
is shown in the status line.

## Configuration

Optional config file at `<agent-dir>/extensions/fast-mode.json` (typically
`~/.pi/agent/extensions/fast-mode.json`):

```json
{
  "enabled": false,
  "models": [
    "openai/gpt-5.4",
    "openai/gpt-5.5",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5"
  ],
  "showStatus": true
}
```

- `enabled`: fast-mode state at session start (`/fast` overrides it for the session;
  the toggle is not written back to the file).
- `models`: the `provider/model-id` keys fast mode applies to. The defaults above are
  used when the file is absent. Models whose API has no fast-mode support are
  ignored.
- `showStatus`: show the `fast` status-line indicator while active.

## Notes

- The priority service tier bills at a higher rate than the default tier — check your
  provider's pricing before leaving it enabled.
- If another extension already set a `service_tier` on the payload, this extension
  leaves it alone.
