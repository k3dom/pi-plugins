# `@pi-plugins/speed`

See estimated generation speed and time to first token in
[pi](https://github.com/earendil-works/pi), above the editor.

## Install

```bash
pi install npm:@pi-plugins/speed
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/speed
```

## Usage

Send a prompt. The status line updates automatically as measurements become
available:

```text
~48 tok/s · TTFT 920ms
```

- `~48 tok/s` means approximately 48 tokens per second, based on recent responses
  from the selected model.
- `TTFT` means time to first token: how long the model takes to start responding.

There are no commands or settings. Use [`elapsed`](../elapsed) to track the full
agent run, including tool calls.
