# `@pi-plugins/claude-oauth`

Compatibility fixes for using a Claude subscription in
[pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@pi-plugins/claude-oauth
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/claude-oauth
```

## Usage

Sign in to Anthropic with `/login`, then select a Claude model from the built-in
`anthropic` provider. The plugin works automatically, with no additional provider or
configuration.

This plugin is for subscription sign-ins, not API-key access.
