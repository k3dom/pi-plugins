# Does the 1h prompt-cache TTL cost Claude subscribers more usage?

Researched 2026-09-21 against Claude Code v2.1.278 (npm `@anthropic-ai/claude-code`, native
binary `@anthropic-ai/claude-code-linux-x64`), Anthropic docs, and `anthropics/claude-code`
issues. Legend: **[doc]** documented fact · **[staff]** Anthropic staff statement · **[code]**
observed in the shipped Claude Code binary · **[community]** third-party measurement, unconfirmed.

## Verdict

It is **not free**. Anthropic's own client treats the 1h TTL as a cost/benefit trade-off for
subscribers, not as a freebie: Claude Code requests 1h only for the main conversation while
within included plan usage, keeps subagents on 5m because "you'd be paying for them even though
they do not benefit from 1h" [staff], and drops back to 5m the moment a subscriber starts drawing
on usage credits [doc][code]. No primary source states that subscription usage metering ignores
cache-write type; the staff statement that a wasted 1h write means "you'd be overcharged" implies
the opposite. **Confidence: high** that 1h writes count against plan limits at a higher weight
than 5m writes; **medium** on the exact weighting (Anthropic publishes no metering formula).
Recommending `PI_CACHE_RETENTION=long` to subscribers is sound for long interactive main-agent
sessions (this mirrors Claude Code's own default), but not as a blanket "it's free" setting, and
subagent runs should stay `short`.

## Findings

### API pricing (applies wherever the request is billed per token)

- 5m cache writes cost 1.25× base input, 1h cache writes cost 2× base input, reads 0.1× for both
  TTLs. The 1h TTL is offered "at additional cost". [doc] — prompt-caching page, Pricing + 1-hour
  sections.
- "Cache hits are not deducted against your rate limit" is listed as a reason to use the 1h cache;
  this is about API org rate limits (ITPM), not subscription plan limits. [doc]
- The response reports write buckets separately: `usage.cache_creation.ephemeral_5m_input_tokens`
  and `ephemeral_1h_input_tokens`; `cache_control.ttl` is typed `'5m' | '1h'`. [doc] SDK types.

### How subscription usage is metered

- Support center: usage "is affected by several factors, including the length and complexity of
  your conversations, the features you use, which Claude model you're chatting with, and the
  effort level"; all surfaces (claude.ai, Claude Code, Desktop) share one pool. No token formula,
  no mention of cache type. [doc]
- Claude Code docs describe plan usage in token terms: cached history is re-read "at the cached
  token rate", and a cache miss "reprocesses your full context" and draws usage; `/usage` flags
  "cache misses" as a behaviour that eats plan limits. [doc] costs page, "Why usage climbs".
- The docs justify the 5m fallback on usage credits with "you are billed for that usage, so Claude
  Code drops the main conversation to the cheaper five-minute TTL" — implying 1h is the *more*
  expensive choice whenever the user pays, and is chosen within plan usage because it saves tokens
  on average, not because it is free. [doc]
- bcherny (Anthropic), 2026-04-13, on #45381: "1h prompt cache is nuanced actually. It costs more
  for cache writes, and less for cache reads. ... Say you use 1h cache for an agent, but only used
  the agent to make a single query -- in this case the 1h cache would be wasted and you'd be
  overcharged. ... we have rolled out 1h prompt cache by default in a number of places for
  subscribers ... but we actually keep it at 5m for many queries also (eg. subagents, which are
  rarely resumed so you'd be paying for them even though they do not benefit from 1h). ... the
  token savings is nowhere near 12x unfortunately. It is a small win though". [staff]
- bcherny, 2026-08-17, on #74075: "On a Claude subscription (Pro/Max/Team/Enterprise) within
  included usage, Claude Code uses the 1-hour prompt-cache lifetime automatically. ... Note that
  1-hour cache writes are billed at a higher rate." [staff]
- bcherny, 2026-08-16, on #84289: Claude Code requests 5m for subagents on a subscription, yet
  some users see 1h writes there; "the effective TTL is being decided further along the pipeline".
  I.e. the server may override the requested TTL for subscribers. [staff]
- No primary source says cache reads or 1h writes are free/discounted for subscribers. The
  "1h is free for subscribers" idea is **[community]** folklore; I found no Anthropic statement
  supporting it.

### Claude Code default TTL and its gates

Documented in the Claude Code prompt-caching page, "Which TTL each request gets" [doc]:

| Request bucket    | Subscription, within plan usage | Usage credits / API key / cloud provider |
| ----------------- | ------------------------------- | ---------------------------------------- |
| Main conversation | 1h                              | 5m                                       |
| Everything else   | 5m (except server-controlled helpers, 1h) | 5m                            |

Precedence (docs + binary agree) [doc][code]:
1. `FORCE_PROMPT_CACHING_5M=1` → 5m for everything
2. `CLAUDE_CODE_PROMPT_CACHE_TTL` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` (v2.1.242+)
3. settings `promptCacheTtl` / `subagentPromptCacheTtl` (v2.1.242+)
4. subagent frontmatter `experimental.cacheTtl` (v2.1.248+), ignored if `1h` while on usage credits
5. `ENABLE_PROMPT_CACHING_1H=1` (`_BEDROCK` variant deprecated) → 1h for everything
6. bucket default above

History [doc] CHANGELOG: 2.1.129 "Fixed 1-hour prompt cache TTL being silently downgraded to 5
minutes"; 2.1.132 Bedrock/Vertex 400 fix for `ENABLE_PROMPT_CACHING_1H`; 2.1.243 added the
`promptCacheTtl` settings "so API-key and cloud-provider users can keep a 1-hour prompt cache on
the main conversation while subagents stay at 5 minutes"; 2.1.248 agent-frontmatter `cacheTtl`.

## What Claude Code actually sends (v2.1.278 binary)

Decision function (deminified, names are mine) [code]:

```
resolveTtl(querySource, {agentCacheTtlOverride, ignoreOverage=false}):
  isSubscriber = usingOAuthLogin() && scopes.includes("user:inference")
  usingOverage = isSubscriber && !ignoreOverage && claudeAiLimits.currentLimits.isUsingOverage === true
  explicit = FORCE_PROMPT_CACHING_5M ? "5m"
           : env CLAUDE_CODE_[SUBAGENT_]PROMPT_CACHE_TTL ?? settings [subagent]promptCacheTtl
           ?? (agentOverride unless agentOverride=="1h" && usingOverage)
           ?? (ENABLE_PROMPT_CACHING_1H || bedrock&&ENABLE_PROMPT_CACHING_1H_BEDROCK ? "1h" : undefined)
  if explicit: return explicit
  if !isSubscriber || usingOverage: return "5m"            // reason: "default"
  allowlist = latched ?? remoteFlag("tengu_prompt_cache_1h_config").allowlist
              ?? ["repl_main_thread*", "sdk", "auto_mode", "memdir_relevance"]
  return matches(querySource, allowlist) ? "1h" : "5m"     // reason: "subscriber"
```

- When the resolved TTL is 1h on a first-party endpoint, every `cache_control` marker becomes
  `{type:"ephemeral", ttl:"1h"}` and the beta `extended-cache-ttl-2025-04-11` is added to
  `anthropic-beta`. Otherwise markers are `{type:"ephemeral"}` with no `ttl` (API default 5m).
- `isUsingOverage` comes from the claude.ai usage-limit response headers Claude Code reads on each
  request; it is "always absent for API-key, Bedrock, and Vertex sessions".
- The main-thread allowlist is a remote-config flag; the client-side fallback includes the main
  REPL thread. Subagents (`agent_*` query sources) are not in the default allowlist → 5m.
- Telemetry/`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` no longer forces 5m: the fallback allowlist
  is baked in (this was the #45381 bug, fixed April 2026 per staff).

## Unconfirmed / open

- **Exact subscription metering weights.** No Anthropic source publishes whether plan usage is
  charged as cost-weighted tokens (i.e. 1h write = 2×, 5m write = 1.25×, read = 0.1×) or some
  other function. Staff wording ("overcharged", "paying for them", "cheaper five-minute TTL")
  points to cost-weighted, but this is inference. [community/inference]
- **Server-side TTL override for subscribers.** bcherny said the effective TTL can be "decided
  further along the pipeline"; users report 1h writes on subagent requests Claude Code sent as
  5m. Whether the server also *downgrades* an explicit 1h request is unknown. [staff + community]
- **"Claude Code moved from 1h to 5m in 2.1.218" (#84253).** Not confirmed as a default change.
  Later measurements in the same thread (674 sessions, 29 versions) show 100% 1h on the main
  thread across 2.1.156–2.1.272 for a plain OAuth login; the original reporter's fleet injected a
  subscription token via `ANTHROPIC_AUTH_TOKEN`, which Claude Code classifies as API-key auth and
  therefore defaults to 5m. [community]
- **Whether pi's `PI_CACHE_RETENTION=long` on a subscriber OAuth session is server-honoured.** The
  API returns `ephemeral_1h_input_tokens` for such requests per user reports (#43566); not
  verified here. [community]

## Sources

- Prompt caching (pricing, 1h section, usage fields): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code — How Claude Code uses prompt caching: https://code.claude.com/docs/en/prompt-caching
- Claude Code — Manage costs ("Why usage climbs", `/usage` breakdown): https://code.claude.com/docs/en/costs
- Claude Code — Settings reference (`promptCacheTtl`, `subagentPromptCacheTtl`): https://code.claude.com/docs/en/settings-reference
- Claude Code — Environment variables (`ENABLE_PROMPT_CACHING_1H`, `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`): https://code.claude.com/docs/en/env-vars
- Claude Code CHANGELOG (2.1.129, 2.1.132, 2.1.243, 2.1.248): https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
- Help Center — How do usage and length limits work: https://support.claude.com/en/articles/11647753-how-do-usage-and-length-limits-work
- Help Center — Manage usage credits for paid Claude plans: https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans
- Plans & pricing (shared usage pool, usage credits at API rates): https://claude.com/pricing
- bcherny on 1h cost trade-off for subscribers (#45381): https://github.com/anthropics/claude-code/issues/45381
- bcherny on subscription default = 1h, "billed at a higher rate" (#74075): https://github.com/anthropics/claude-code/issues/74075
- bcherny on subagents 5m / server-side TTL decision (#84289): https://github.com/anthropics/claude-code/issues/84289
- Community: TTL downgrade on Extra Usage (#43566): https://github.com/anthropics/claude-code/issues/43566
- Community: alleged 2.1.218 regression + ANTHROPIC_AUTH_TOKEN detection gap (#84253): https://github.com/anthropics/claude-code/issues/84253
- SDK types `CacheControlEphemeral.ttl`, `CacheCreation`: https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts
- Claude Code binary: `npm pack @anthropic-ai/claude-code-linux-x64@2.1.278`, `strings claude | grep -E 'FORCE_PROMPT_CACHING_5M|tengu_prompt_cache_1h_config|extended-cache-ttl'`
- pi's mapping of `PI_CACHE_RETENTION=long` → `ttl:"1h"`: `.agents/repos/pi/packages/ai/src/api/anthropic-messages.ts` (`getCacheControl`)
