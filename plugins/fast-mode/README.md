# `@pi-plugins/fast-mode`

Request priority inference for selected models in
[pi](https://github.com/earendil-works/pi) with a session toggle.

## Install

```bash
pi install npm:@pi-plugins/fast-mode
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/fast-mode
```

## Usage

Use `/fast` to control fast mode for the current session:

| Command        | Action                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `/fast`        | Toggle fast mode.                                                            |
| `/fast on`     | Enable fast mode.                                                            |
| `/fast off`    | Disable fast mode.                                                           |
| `/fast status` | Show the current state and explain whether it applies to the selected model. |

To start a session with fast mode enabled:

```bash
pi --fast
```

Fast mode applies only to models listed in the configuration. Other models are left
unchanged. A `[fast mode]` indicator appears above the editor while active.

## Supported providers

| Provider     | Pi provider    |
| ------------ | -------------- |
| OpenAI       | `openai`       |
| OpenAI Codex | `openai-codex` |

Priority availability depends on the provider and model.

## Configuration

Optionally create `<agent-dir>/extensions/fast-mode.json`, typically
`~/.pi/agent/extensions/fast-mode.json`. The defaults are:

```json
{
  "enabled": false,
  "models": [
    "openai/gpt-5.4",
    "openai/gpt-5.5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "openai/gpt-6-astra",
    "openai-codex/gpt-5.4",
    "openai-codex/gpt-5.5",
    "openai-codex/gpt-5.6-sol",
    "openai-codex/gpt-5.6-terra",
    "openai-codex/gpt-5.6-luna",
    "openai-codex/gpt-6-astra"
  ],
  "showStatus": true
}
```

| Setting      | Description                                                                                                 |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `enabled`    | Enable fast mode at session start. `/fast` changes only the current session and does not write to the file. |
| `models`     | The exact `provider/model-id` pairs fast mode applies to.                                                   |
| `showStatus` | Show the status indicator while fast mode is active.                                                        |

## Notes

Priority inference can cost more. Check your provider's pricing before enabling it.
