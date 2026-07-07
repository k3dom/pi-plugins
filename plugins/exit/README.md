# `@pi-plugins/exit`

A [pi-agent](https://github.com/earendil-works/pi) extension that exits pi when you
submit `exit` or `quit` as the whole prompt.

## Install

```bash
pi install npm:@pi-plugins/exit
```

For one-off testing without adding it to settings:

```bash
pi -e npm:@pi-plugins/exit
```

## Usage

Submit either command by itself:

```text
exit
```

```text
quit
```

The extension handles the input locally and requests pi's normal graceful shutdown,
so the prompt is not sent to the model.
