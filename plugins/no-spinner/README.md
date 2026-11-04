# `@pi-plugins/no-spinner`

Keep [pi](https://github.com/earendil-works/pi) light on CPU while it works by
removing the animated spinner from the working indicator.

## Install

```bash
pi install npm:@pi-plugins/no-spinner
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/no-spinner
```

## Usage

Send a prompt. The working indicator shows pi's working message without the spinner.
There are no commands or settings.

## Why

Pi redraws the screen for every spinner frame, 12 times a second, and each redraw
renders the transcript again. In a long session that takes a large share of a CPU
core for as long as pi works: about 40% in fullscreen mode and 18% in regular mode,
compared with 4 to 6% without the spinner. Without the spinner, pi redraws only when
something on screen changes.

## Notes

- Available only in interactive terminal mode.
- Pi still redraws once a second while a bash command runs, to update its duration.
