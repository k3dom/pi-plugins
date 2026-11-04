# `@pi-plugins/elapsed`

Track how long the agent has been working in
[pi](https://github.com/earendil-works/pi) with a live timer in the working
indicator.

## Install

```bash
pi install npm:@pi-plugins/elapsed
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/elapsed
```

## Usage

Send a prompt. The working indicator shows elapsed time in place of pi's spinner:

```text
Working... 1m 04s
```

The timer starts at `0s` for each agent run and disappears when it ends. It includes
time spent using tools. There are no commands or settings.

## Notes

- Available only in interactive terminal mode.
- Automatic retries can reset the timer.
- Hides pi's animated spinner, because each spinner frame redraws the whole
  transcript and takes a lot of CPU in long fullscreen sessions. The timer ticks once
  a second instead.
- Use [`speed`](../speed) for generation speed and time to first token.
