---
'@pi-plugins/claude-cli': minor
---

Build every request with pi's own Anthropic provider and leave only sending it to
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
