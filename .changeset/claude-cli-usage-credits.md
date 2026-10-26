---
'@pi-plugins/claude-cli': minor
---

Stop when a request is charged to Claude usage credits instead of your plan's limits.
When Claude Code reports that a response was paid from usage credits, or Anthropic
refuses to bill a request to your plan's limits, pi stops with an error and does not
retry. Set `PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1` to allow usage credits.
