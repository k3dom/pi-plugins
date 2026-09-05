# `@pi-plugins/usage`

Check subscription usage and rate limits in
[pi](https://github.com/earendil-works/pi) with a command and a compact status
widget.

## Install

```bash
pi install npm:@pi-plugins/usage
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/usage
```

## Usage

Authenticate a supported provider in pi, then run:

```text
/usage
```

The command shows provider sections with usage bars, percentages, and reset times
where available. Missing credentials or failed requests appear as warnings.

When the selected model belongs to a supported provider, a compact widget shows its
limits above the editor.

## Supported providers

The plugin uses the credentials you have already configured in pi.

| Provider           | Pi provider     | Authentication                      |
| ------------------ | --------------- | ----------------------------------- |
| Claude             | `anthropic`     | Subscription sign-in with `/login`. |
| OpenAI Codex       | `openai-codex`  | Subscription sign-in with `/login`. |
| GLM Coding         | `zai`           | API key.                            |
| GLM Coding (China) | `zai-coding-cn` | API key.                            |

## Configuration

Optionally create `<agent-dir>/extensions/usage.json`, typically
`~/.pi/agent/extensions/usage.json`. The defaults are:

```json
{
  "showWidget": true
}
```

| Setting      | Description                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------- |
| `showWidget` | Show rate-limit bars above the editor. Set to `false` to hide them; `/usage` remains available. |
