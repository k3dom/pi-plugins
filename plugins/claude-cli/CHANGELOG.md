# @pi-plugins/claude-cli

## 0.3.0

### Minor Changes

- 235a718: Stop when a request is charged to Claude usage credits instead of your plan's limits.
  When Claude Code reports that a response was paid from usage credits, or Anthropic
  refuses to bill a request to your plan's limits, pi stops with an error and does not
  retry. Set `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1` to allow usage credits.

## 0.2.2

### Patch Changes

- e55688b: Load in pi again. Since 0.2.0 the plugin imported a part of pi-ai that pi does not
  provide to extensions, so pi failed to load it and offered no `claude-cli` models.

## 0.2.1

### Patch Changes

- 6affc3c: Keep working after pi's working directory is moved during a session. Every request
  used to fail with "Claude Code CLI not found", because Claude Code was started in the
  directory's old path.

## 0.2.0

### Minor Changes

- 4de58a5: Build every request with pi's own Anthropic provider and leave only sending it to
  Claude Code. Requests now match those of pi's `anthropic` provider, which brings:

  - On Claude Opus 4.8 and later, Sonnet 5.5 and Fable 5, a system prompt or tool change
    during a session is sent as a message, so the cached conversation stays valid
    instead of being written to the cache again.
  - These models also keep the effort of each earlier turn on record.
  - Responses can use the model's full output limit instead of Claude Code's lower
    default.
  - Tool arguments stream as they are generated, and pi's request and response hooks
    see `claude-cli` requests.

  Sessions started with an earlier version write their cache once more after the
  update, because pi now replays their earlier thinking as text.

### Patch Changes

- 571da68: Start Claude Code for the next request of a session ahead of time, which saves about
  a fifth of a second on every request from the third on. The idle process is stopped
  after five minutes and when the session ends.
- b6b8bde: Run all requests of a pi session as one Claude Code session, as Claude Code itself
  does, instead of starting a new one for every request.
- 42f4495: Lift the 2 MiB limit on the session history. The conversation now reaches Claude Code
  over stdin instead of through a settings file, so long sessions and sessions with
  screenshots no longer fail with `Settings file exceeds the 2MiB limit`. Prompt caching
  works as before.

## 0.1.0

### Minor Changes

- 075e4b7: Add the `claude-cli` provider, which runs Claude models through the Claude Code CLI so
  requests use your Claude subscription with Claude Code's own sign-in. Install `claude`
  and sign in with `claude auth login`, then pick a model such as
  `claude-cli/claude-sonnet-5-5`.
