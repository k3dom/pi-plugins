# @pi-plugins/claude-max

Make pi's Anthropic **OAuth (Claude Pro/Max subscription)** requests match the
current Claude Code client fingerprint.

pi already supports Anthropic OAuth out of the box (`/login anthropic`) and sends
a baseline Claude Code identity. This plugin closes the gap between that baseline
and what the current Claude Code CLI actually sends on the wire, so subscription
inference looks like a genuine Claude Code request.

## What it does

Three layers, all applied only to **OAuth Anthropic** requests (it keys off the
`You are Claude Code, …` system block that pi injects only for OAuth tokens, so
API-key traffic and other providers are never touched):

1. **Headers** — via `registerProvider("anthropic", { headers })`. Refreshes the
   `User-Agent` and `anthropic-beta` set to the current Claude Code version and
   adds the `X-Stainless-*` / `anthropic-client-*` identity headers. Header-only
   registration augments the built-in provider; OAuth login and models are
   preserved. The OAuth `Authorization: Bearer` token is untouched.
2. **Body** — via the `before_provider_request` hook. Prepends the
   `x-anthropic-billing-header` block as `system[0]`, cloaks `metadata.user_id`
   into the Claude Code `{ device_id, session_id }` shape, and clamps
   `max_tokens` to Claude Code's 64k ceiling.
3. **`cch` attestation** — via a global `fetch` wrapper installed at load. After
   the body is serialized it patches the billing header's `cch` placeholder with
   `XXH64(body) & 0xfffff`. The wrapper is a strict pass-through for every
   request that does not carry the placeholder.

TLS needs nothing: Claude Code's "TLS fingerprint" is just the Node/Bun default
cipher list, which any Node/Bun runtime (including pi) already matches.

## Install

Add the built extension to your pi config's extension list (this package exposes
it via the `pi.extensions` field), then restart pi. You must already be logged in
with `/login anthropic` using a Claude Pro/Max account.

## Configuration

| Env var                   | Effect                               |
| ------------------------- | ------------------------------------ |
| `PI_CLAUDE_MAX_DISABLE=1` | Disable the plugin entirely (no-op). |

## Refreshing the fingerprint

The constants in `src/fingerprint.ts` (versions, header values, beta list) are
**Claude-Code-version-specific**. `scripts/claude-trace.ts` reseeds them from a
live capture: it runs a local MITM proxy, drives the real `claude` CLI through it
(`claude -p`), captures the first genuine `/v1/messages` request, and diffs every
pinned constant against the current source.

```sh
# Requires Node 24+, `openssl` and `claude` on PATH, logged into a Pro/Max account.
pnpm --filter @pi-plugins/claude-max capture           # report the diff only
pnpm --filter @pi-plugins/claude-max capture --write   # patch src/fingerprint.ts
pnpm --filter @pi-plugins/claude-max exec oxfmt         # then reformat + review git diff
```

Beyond the readable constants, the run **verifies against the captured bytes**
the two values that can't be read off the wire: the `cch` XXH64 seed
(`src/cch.ts`) and the billing-header fingerprint salt/indices. A `✗` there means
Claude Code changed the attestation algorithm itself — not something `--write`
can fix from a capture. Use `--manual` to drive `claude` yourself instead of
spawning it, or `--json` to dump the raw exchange.

## Limitations & maintenance

- If the XXH64 self-test fails on an exotic runtime, or the billing block cannot
  be anchored in the serialized body, the request is still sent — just with an
  unattested `cch=00000` (the same graceful fallback OMP uses).
- This plugin does not perform OAuth login or token refresh; pi owns that.

## Compatibility

Built against `@earendil-works/pi-coding-agent` `0.80.3` and
`@anthropic-ai/sdk` `0.91.x`. The `cch` fetch wrapper relies on the SDK reading
`globalThis.fetch` at client construction; if a future pi/SDK passes its own
`fetch`, cch silently degrades to the unattested fallback (headers and body
shaping still apply).
