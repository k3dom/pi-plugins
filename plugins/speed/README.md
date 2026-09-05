# `@pi-plugins/speed`

A [pi-agent](https://github.com/earendil-works/pi) extension that shows how fast the
current model is generating — tokens per second and time to first token — on a shared
status line above the editor. The rate is a smoothed estimate from recent completed
responses for the selected model.

## Install

```bash
pi install npm:@pi-plugins/speed
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/speed
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/speed
```

## Usage

There is nothing to run. The status line keeps itself up to date:

```text
~48 tok/s · TTFT 920ms
```
