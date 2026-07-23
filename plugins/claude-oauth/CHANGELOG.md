# @pi-plugins/claude-oauth

## 0.3.0

### Minor Changes

- 87649aa: Apply Anthropic's one-hour cache TTL to the existing cache breakpoints in Claude
  subscription requests handled by `claude-oauth`, without changing API-key requests
  or requiring the process-wide `PI_CACHE_RETENTION` setting. Subagents now override
  `PI_CACHE_RETENTION` to `short` in their inherited environment so spawned pi
  instances retain the standard cache duration, including when the OAuth plugin is
  loaded in the child.

## 0.2.2

### Patch Changes

- 6234a89: Publish the upgraded runtime and build dependencies, including Effect 4.0.0-beta.100 and Pi 0.81.1 compatibility updates.

## 0.2.1

### Patch Changes

- 4a50495: Remove Pi's generated documentation section from sanitized Anthropic OAuth system prompts instead of relabeling it as Claude Code documentation.

## 0.2.0

### Minor Changes

- 0a30b41: Add `claude-oauth` plugin: makes pi's Anthropic OAuth requests match the
  current Claude Code client so OAuth login works correctly.
