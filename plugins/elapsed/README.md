# `@pi-plugins/elapsed`

A [pi-agent](https://github.com/earendil-works/pi) extension that shows how long the
agent has been working on the current prompt, as a live clock in pi's working
indicator.

```text
⠹ Working... 1m 04s
```

## Install

```bash
pi install npm:@pi-plugins/elapsed
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/elapsed
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/elapsed
```

## Usage

Nothing to configure. Send a prompt and the working indicator counts up next to the
spinner, restarting at `0s` for every prompt and disappearing when the agent is done.

## Notes

- The clock covers one full prompt — the whole agent run, including every turn and
  tool call — not a single LLM request. For per-request timings use
  [`speed`](../speed).
- It ticks once per second and replaces pi's default `Working...` message. Pi's own
  message is restored when the run ends.
- Interactive (TUI) mode only. In RPC, print, and JSON modes there is no working
  indicator, so the extension stays idle.
- While pi shows a different status row — retrying, compacting, summarizing a branch
  — that row is displayed instead. Time keeps accruing and the clock reappears with
  the working indicator.
