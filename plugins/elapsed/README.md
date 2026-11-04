# `@pi-plugins/elapsed`

<!-- prettier-ignore -->
> [!WARNING]
> This package is deprecated. Use
> [`@pi-plugins/no-spinner`](https://github.com/k3dom/pi-plugins/tree/master/plugins/no-spinner)
> instead. Each tick of the timer redraws the whole transcript, which still takes a lot
> of CPU in sessions with long tool output. `no-spinner` keeps the working indicator
> still, so pi redraws only when something else changes.
>
> To switch:
>
> ```bash
> pi remove npm:@pi-plugins/elapsed
> pi install npm:@pi-plugins/no-spinner
> ```

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
- Pi's spinner redraws the whole transcript every 80 ms, which takes a lot of CPU in
  long fullscreen sessions.
- Use [`speed`](../speed) for generation speed and time to first token.
