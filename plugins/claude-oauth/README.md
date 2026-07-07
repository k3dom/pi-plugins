# `@pi-plugins/claude-oauth`

A [pi-agent](https://github.com/earendil-works/pi) extension that makes pi's
Anthropic OAuth requests match the current Claude Code client, so signing in with a
Claude subscription (OAuth) works correctly.

## Install

```bash
pi install npm:@pi-plugins/claude-oauth
```

For one-off testing without adding it to settings:

```bash
pi -e npm:@pi-plugins/claude-oauth
```

## Usage

There is nothing to configure or toggle, and no new provider to add. Once installed,
the extension automatically augments pi's existing built-in `anthropic` provider and
applies to its OAuth requests; every other request passes through unchanged. Keep
using the `anthropic` provider exactly as you normally would.
