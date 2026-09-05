# `@pi-plugins/exit`

Quit [pi](https://github.com/earendil-works/pi) by typing `exit` or `quit` as a
prompt.

## Install

```bash
pi install npm:@pi-plugins/exit
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/exit
```

## Usage

Submit either word by itself, without a slash:

```text
exit
```

```text
quit
```

Pi exits once it is idle. The prompt is not sent to the model. There is nothing to
configure.

Capitalization and surrounding whitespace do not matter. Prompts with additional text
are left unchanged.
