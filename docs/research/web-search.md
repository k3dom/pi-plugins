# How coding agents implement `web_search`

Research for a new `web_search` plugin in this monorepo (sibling of
`plugins/webfetch/`). Three primary sources were read from their actual source code,
then the zero-setup provider candidates they rely on were verified empirically with
`curl`.

Snapshot dates (all reads/tests done 2026-09-14):

| Source                     | What was read                                                                                                                                 | Revision                                  |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `nicobailon/pi-web-access` | GitHub `main`                                                                                                                                 | `192ac18`, package `pi-web-access@0.29.0` |
| `pi-web-search`            | npm tarball `pi-web-search@1.5.0` (repo `ttttmr/pi-web-search`)                                                                               | published 2026-09-08                      |
| `anomalyco/opencode`       | tag **`v2.0.3`** (`d44b52c`, "release: v2.0.3") — the v2 line. Also read v1 `dev` branch (`228e909`, package `opencode@1.18.30`) for contrast | see [§3](#3-opencode-v2)                  |

Local conventions this must fit: `plugins/webfetch/src/index.ts` registers a tool via
`pi.registerTool({ name, label, description, promptSnippet, parameters: Type.Object(...), execute, renderResult })`,
runs an Effect program with `runTool()` from `@pi-plugins/shared/run`, truncates with
`truncateHead`, and renders through `ExpandableText` from `@pi-plugins/shared/ui`.
HTTP goes through `effect/unstable/http` `HttpClient` with retry + timeout
(`plugins/webfetch/src/fetch.ts`). Build is tsdown; deps are Effect v4 beta,
`linkedom`, `defuddle`, `turndown`.

---

## 1. `nicobailon/pi-web-access`

Repo: https://github.com/nicobailon/pi-web-access. Files are referenced relative to
the repo root (flat layout, no `src/`).

### Size / complexity

- ~29,900 lines of top-level `.ts` (`wc -l *.ts`), 82 test files under `test/`.
  `index.ts` alone is 3,584 lines; `curator-page.ts` 3,608; `extract.ts` 1,464.
- Runtime deps (`package.json`): `@mozilla/readability`, `defuddle`, `linkedom`,
  `p-limit`, `promise.try`, `turndown`, `typebox`, `unpdf`, `undici`.
- Registers four tools: `web_search`, `fetch_content`, `get_search_content`,
  `source_check` (`index.ts:1789`, `:2486`, `:2830`, `:2387`), plus an interactive
  browser "curator" UI (`curator-server.ts`, `curator-page.ts`).
- Verdict: a maximal, kitchen-sink design. Useful as a catalogue of provider request
  shapes, not as a template.

### Providers

30 resolvable providers are enumerated in `gemini-search.ts:44`
(`RESOLVED_SEARCH_PROVIDERS`). The ones relevant to a zero-setup plugin:

| Provider                     | File                        | Key required?                                                                                                                                                                                 | Endpoint / shape                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Exa (MCP, keyless)**       | `exa.ts:9,205-290`          | No. `isExaAvailable()` returns `true` unconditionally (`exa.ts:442`). With `exaApiKey`/`EXA_API_KEY` it switches to the direct REST API (`api.exa.ai/answer` or `/search`, `exa.ts:454-526`). | `POST https://mcp.exa.ai/mcp?tools=<tool>` with JSON-RPC `tools/call` `{name:"web_search_exa", arguments:{query, numResults}}`; headers `Accept: application/json, text/event-stream`, `x-exa-source: pi-web-access`. Response is SSE (`data:` lines) or plain JSON; the text payload is `Title:/URL:/Published:/Author:/Highlights:` blocks separated by `\n\n---\n\n`, parsed with regexes (`exa.ts:292-330`). On 429 the error tells the user to add `exaApiKey` (`exa.ts:231`). Filtered searches (domain/recency/content) try `web_search_advanced_exa` first and fall back (`exa.ts:399-418`). |
| **DuckDuckGo (HTML scrape)** | `duckduckgo.ts` (137 lines) | No. Always "available" but **explicit-only** — never in the auto chain (`gemini-search.ts:104-106`, README "explicit-only").                                                                  | `GET https://html.duckduckgo.com/html/?q=…`, `Accept: text/html`, custom UA. Parses with `linkedom`: `.result` containers, skips `.result--ad`, title from `.result__a`, URL decoded from the `uddg` query param of the redirect link, snippet from `.result__snippet` (`duckduckgo.ts:69-120`). Throws if zero parseable results ("invalid response"). 30 s timeout.                                                                                                                                                                                                                                |
| **SearXNG**                  | `searxng.ts`                | No key but needs a self-hosted URL: `searxngBaseUrl` in config or `SEARXNG_BASE_URL` (`searxng.ts:68,117`). First in the auto chain when configured (`gemini-search.ts:587`).                 | `GET {base}/search?q=…&format=json[&time_range=…]`; reads `results[].{title,url,content}` and `answers[]` (`searxng.ts:195-253`). Runs through SSRF protection.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Jina**                     | `jina-search.ts`            | **Yes** — `isJinaSearchAvailable()` requires `jinaApiKey`/`JINA_API_KEY` (`jina-search.ts:213-219`).                                                                                          | `GET https://s.jina.ai/<encoded query>?count=N&site=…`, headers `Authorization: Bearer`, `Accept: application/json`, `X-Respond-With: no-content                                                                                                                                                                                                                                                                                                                                                                                                                                                     | content`, `X-Retain-Images: none` (`jina-search.ts:221-236`). Recency and `-site:` exclusions are folded into the query string (`buildSearchRequest`). |
| **Brave**                    | `brave.ts`                  | Yes (`braveApiKey`/`BRAVE_API_KEY`, `brave.ts:43-44`).                                                                                                                                        | `GET https://api.search.brave.com/res/v1/web/search?q&count&freshness=pd                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pw                                                                                                                                                     | pm  | py`, header `X-Subscription-Token` (`brave.ts:7,160-178`). |
| **Tavily**                   | `tavily.ts`                 | Yes (`tavilyApiKey`/`TAVILY_API_KEY`, `isTavilyAvailable`). Does **not** use Tavily's keyless mode.                                                                                           | `POST https://api.tavily.com/search` `{query, search_depth:"basic", max_results, include_domains, exclude_domains, time_range}` with `Authorization: Bearer` (`tavily.ts:8,104-190`).                                                                                                                                                                                                                                                                                                                                                                                                                |

Other providers (OpenAI Responses `web_search`, Gemini grounding, Perplexity,
Parallel, TinyFish, Firecrawl, Kagi, Serper, SerpApi, Bright Data, …) all require
keys or subscriptions; see `gemini-search.ts:44` and the README table.

### Selection / configuration

- Config file: `~/.pi/agent/web-search.json` (XDG or legacy dir, `utils.ts:19-30`),
  plus per-provider env vars (`EXA_API_KEY`, `BRAVE_API_KEY`, …).
- `provider` param on the tool, or top-level `provider` in config, or an ordered
  `searchRouting.providers` list with `fallbackOn` error kinds (README,
  `gemini-search.ts:60-64`).
- Auto chain (`gemini-search.ts:572-750`): SearXNG (if configured) → OpenAI via Codex
  auth (if current model is `openai-codex`) → **Exa MCP keyless** → OpenAI → Brave →
  Parallel → TinyFish → … → Gemini. Each step is
  `try { … } catch { push error; continue }`; if everything fails it throws an
  aggregated `"Auto provider search failed:\n - …"`. DuckDuckGo is deliberately
  excluded.

### Tool surface

`index.ts:1789-1815`. Name `web_search`, label "Web Search". Description is a
~1,100-character paragraph listing every provider and routing rule (too long to
quote; it is at `index.ts:1792`). `promptSnippet`: "Use for web research questions.
Prefer {queries:[...]} with 2-4 varied angles…".

Parameters (typebox):

```ts
query?: string            // single query
queries?: string[]        // batch, up to 3 concurrent
numResults?: integer      // 1..20, default 5
includeContent?: boolean  // background-fetch full pages
recencyFilter?: "day"|"week"|"month"|"year"
domainFilter?: string[]   // "-example.com" to exclude
provider?: <enum | enum[] | "all" | "auto">
workflow?: "none"|"summary-review"|"auto-summary"
proxy?: string
```

### Output to the model

`buildSearchReturn` (`index.ts:1378-1470`) + `formatSearchSummary`
(`index.ts:745-752`). Per query:

```
{answer}

---

**Sources:**
1. {title}
   {url}

2. …
```

where `answer` is provider-synthesised text, or for snippet-only providers
(DDG/SearXNG/Exa-MCP) is the snippets joined as
`"{snippet}\nSource: {title} ({url})"` (`duckduckgo.ts:109-112`, `exa.ts:314-325`,
capped at 500 chars/snippet). Then trailers:
`Results stored as responseId "…". Use get_search_content(...)` and optionally
`Content fetching in background [id]`.

### Search + fetch coupling

Coupled but asynchronous: `includeContent: true` kicks off a background fetch of all
result URLs (`startBackgroundFetch`), stores them in a `web-search-cache` dir, and
the model retrieves them via `get_search_content` (README "get_search_content").
Plain fetching is a separate `fetch_content` tool.

### Errors / limits / timeouts

- Per-provider 30–60 s `AbortSignal.timeout` (e.g. `duckduckgo.ts:5`, `exa.ts:102`),
  combined with the tool's abort signal via `AbortSignal.any`.
- `SearchProviderError` with a `kind` taxonomy
  (`transient|quota|network|credential|config|auth|invalid-request|invalid-response|unsupported|aborted|unknown`,
  `gemini-search.ts:49-60`) drives routing fallback.
- Result count clamped 1..20 (`normalizeCount`).
- Errors are rendered through `render-search-error.ts` with expandable diagnostics.

### UI

`renderCall` (`index.ts:2131-2154`): `search "query"` (truncated to 60 chars), or
`search N queries` + up to 5 listed. `renderResult` (`index.ts:2156-2380`): progress
bar while partial (`[█████░░░░░] query`), curator phases, then a status line
`N sources` plus expanded per-query answer/sources.

---

## 2. `pi-web-search` (ttttmr)

Package page: https://pi.dev/packages/pi-web-search?name=web. Source read from the
npm tarball `pi-web-search@1.5.0` (`src/index.ts`, `src/web_search.ts`, `src/api.ts`,
`src/utils.ts`, `src/url_context.ts`); repo https://github.com/ttttmr/pi-web-search.

### Size / complexity

1,691 lines total (`api.ts` 1,111), **zero runtime dependencies**, peers on
`@earendil-works/pi-*` and `typebox`.

### Providers — provider-native only

There is no search API at all. The tool calls the **current model's own provider**
with that provider's server-side search tool, reusing pi's stored credentials
(`ctx.modelRegistry.getApiKeyAndHeaders(model)`, `api.ts:68`):

| Provider kind (`api.ts:35-44`)                                                            | Request                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `google` (`google-generative-ai`)                                                         | Gemini `generateContent` with `tools:[{google_search:{}}]` (+ `url_context`)                                                                                                                                         |
| `openai` / `xai` (`openai-responses`, `azure-openai-responses`, `openai-codex-responses`) | Responses API, `tools:[{type:"web_search"}]`, `include:["web_search_call.action.sources", "web_search_call.results"]`, `stream:true` (`api.ts:697-708`)                                                              |
| `anthropic` (`anthropic-messages`)                                                        | Messages API, `tools:[{type:"web_search_20250305", name:"web_search", max_uses:10}]`, `stream:true` (`api.ts:906-913`); OAuth tokens get the `claude-code-20250219,oauth-2025-04-20` beta headers (`api.ts:894-899`) |

Key required: whatever key/OAuth the current pi model already uses. No extra signup,
but it only works when the active model is one of these; otherwise the tool returns
`Failed: The current model … does not support native web search`
(`utils.ts:100-115`). It intentionally does **not** auto-switch to another configured
model "to avoid unexpected API costs".

### Selection / configuration

Uses `ctx.model`; optional `~/.pi/agent/web-search.json` `{provider, model}` (env
override `PI_WEB_SEARCH_CONFIG`) pins a dedicated search model (`utils.ts:36-77`).

### Tool surface (`src/index.ts:60-93`, `src/web_search.ts:6-13`)

```ts
name: "web_search", label: "Web Search",
description: "Search the web using the current supported provider (Google Gemini, xAI Grok, OpenAI, or Anthropic). Optionally include URLs to analyze alongside search results.",
parameters: { query: string, urls?: string[] (max 20) }
```

### Output

The provider LLM's synthesised answer with inline citations (`applyCitations`),
followed by:

```
## Sources
1. [title](url)

## Additional Search Results
1. title - url
```

Truncated with pi's `truncateHead` at `DEFAULT_MAX_LINES/BYTES` + `[Truncated]`
(`utils.ts:10-16`). Note the output is an LLM answer _about_ the results, not the
results themselves.

### Search + fetch coupling

Coupled at the provider: the provider model reads pages itself; `urls` passes extra
pages in. Separate Gemini-only `url_context` tool.

### Errors / limits

Errors become `{content:"Failed: …", details:{error}}` via `errorResult`. No retries
or rate-limit handling of its own; relies on the provider. Max tokens for the
Anthropic call clamped to 1024–8192 (`api.ts:904`).

### UI

`renderCall`: `web_search <query> + N URLs`. `renderResult`: **empty when collapsed
and not an error**; full text when expanded (`index.ts:76-86`). A
`session_start`/`model_select` hook removes `url_context` from active tools for
non-Gemini models (`createModelScopedToolManager`).

---

## 3. opencode v2

Repo: https://github.com/anomalyco/opencode. Branch/tag note: the default branch
`dev` is still the **v1** line (`packages/opencode/`, version 1.18.30). The v2 code
lives in tags `v2.0.0`–`v2.0.3` and the `v2`/`beta` branches with a restructured
layout (`packages/core`, `packages/cli`, `packages/schema`, …). Everything below is
from tag **`v2.0.3`**; `v2` branch HEAD (`f1149ef`) differs from it in the websearch
files by 6 lines.

### Size / complexity

Websearch-related code in v2 (`wc -l`):

| File                                                                                                                          | Lines                 | Role                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------- |
| `packages/core/src/tool/plugin/websearch.ts`                                                                                  | 193                   | the tool                               |
| `packages/core/src/websearch.ts`                                                                                              | 227                   | provider registry, selection, cooldown |
| `packages/core/src/plugin/websearch/{exa,firecrawl,parallel,tavily,tinyfish,mcp,index}.ts`                                    | 82/84/103/86/82/69/13 | provider plugins                       |
| `packages/schema/src/websearch.ts`, `packages/schema/src/config/websearch.ts`, `packages/core/src/config/plugin/websearch.ts` | 42/17/19              | schemas + config                       |

≈1,000 lines, all Effect (v4 `effect` + `effect/unstable/http`, same stack as this
repo). Compared with v1's 143-line `websearch.ts` + 96-line `mcp-websearch.ts`.

### Providers — five, **all usable without a key**

`packages/core/src/plugin/websearch/index.ts` registers Exa, Firecrawl, Parallel,
Tavily, TinyFish. Each plugin declares an integration with methods `{type:"key"}` and
`{type:"env", names:[…_API_KEY]}`, then adds a provider whose `execute` **only
attaches credentials if a connection exists**:

| ID                           | Endpoint                                                                                                 | Anonymous mechanism                                                       | Keyed mechanism           | Request → results                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `exa` (`exa.ts`)             | `POST https://mcp.exa.ai/mcp` (MCP JSON-RPC `tools/call` `web_search_exa` `{query, numResults: 8}`)      | plain call                                                                | `?exaApiKey=` query param | text blocks `Title:/URL:/Published:/Highlights:` split on `\n\n---\n\n`, regex-parsed (`exa.ts:65-82`) |
| `tavily` (`tavily.ts`)       | `POST https://api.tavily.com/search` `{query, search_depth:"basic", chunks_per_source:3, max_results:8}` | header **`X-Tavily-Access-Mode: keyless`** (+ `X-Client-Name: opencode2`) | `Authorization: Bearer`   | JSON `results[].{title,url,content}`                                                                   |
| `parallel` (`parallel.ts`)   | `POST https://search.parallel.ai/mcp` (`web_search` `{objective, search_queries:[query]}`)               | plain call                                                                | `Authorization: Bearer`   | `structuredContent.results[].{url,title,publish_date,excerpts[]}`                                      |
| `firecrawl` (`firecrawl.ts`) | `POST https://mcp.firecrawl.dev/v2/mcp` (`firecrawl_search` `{query, limit:8}`)                          | plain call                                                                | `Authorization: Bearer`   | text is JSON `{success, data:{web:[{url,title,description}]}}`                                         |
| `tinyfish` (`tinyfish.ts`)   | `POST https://agent.tinyfish.ai/mcp` (`search` `{query}`)                                                | header `X-TinyFish-Access-Mode: keyless`                                  | `X-API-Key`               | text is JSON `{results:[{url,title,snippet}]}`                                                         |

The shared MCP caller `mcp.ts` posts JSON-RPC 2.0 with
`Accept: application/json, text/event-stream`, reads at most 256 KiB
(`MAX_RESPONSE_BYTES`), parses either a direct JSON body or SSE `data:` lines, and
has a 25 s timeout (`Effect.timeoutOrElse`). Tavily has its own 25 s timeout.

**No opencode-hosted proxy is involved** — every call goes straight from the client
to the vendor endpoint. Tests confirm the keyless headers
(`packages/core/test/plugin/websearch.test.ts:217-282` for Tavily, `:284-340` for
TinyFish, `:100-140` for the Exa `?exaApiKey=` form).

The public docs (`services/www/src/docs/content/websearch.mdx`) list four providers
(Exa, Firecrawl, Parallel, Tavily; TinyFish is in code but not docs) and say "Connect
an account from the TUI with `/connect`, or set the provider's environment variable"
— the docs don't advertise that keyless works, but the code does it.

### v1 (`dev` branch) for contrast

`packages/opencode/src/tool/websearch.ts`: only Exa MCP and Parallel MCP, keyless by
default; `EXA_API_KEY` is appended as `?exaApiKey=` and `PARALLEL_API_KEY` as a
Bearer (`mcp-websearch.ts:4-7`, `websearch.ts:54-58`). Provider chosen by env
`OPENCODE_WEBSEARCH_PROVIDER`, else `OPENCODE_ENABLE_EXA`/`OPENCODE_ENABLE_PARALLEL`
flags (`effect/runtime-flags.ts:31-39`), else a **checksum of the session ID mod 2**
(`websearch.ts:29-37`). Parameters were richer (`numResults`, `livecrawl`,
`type: auto|fast|deep`, `contextMaxCharacters`) and the raw MCP text was returned
verbatim as the tool output. Description was a `websearch.txt` file with `{{year}}`
substitution.

### Selection / configuration (v2)

`packages/core/src/websearch.ts`:

- Config `websearch: { provider: "<id>" | "random" } | false` in `opencode.jsonc`
  (`packages/schema/src/config/websearch.ts`), applied by
  `packages/core/src/config/plugin/websearch.ts`. `false` deletes the tool from the
  model's tool list via a `session` `context` hook
  (`tool/plugin/websearch.ts:181-190`).
- Otherwise the selection is persisted in KV under `websearch:provider`.
- If nothing is selected, the first call raises `ProviderRequired`; the tool then
  opens an interactive form (`forms.ask`) — "Allow OpenCode to search the web…?" with
  options _allow via Exa, Firecrawl, …_ (→ `"random"`), _choose another provider_,
  _disable_ — under a semaphore and a 1-minute timeout
  (`tool/plugin/websearch.ts:64-141`).
- `"random"`: pick a random provider per session (sticky affinity), and on HTTP
  **429** put that provider into cooldown for `Retry-After` (or 60 s) and retry
  another provider; fail only when all are cooling down
  (`websearch.ts:117-140,166-197`, `cooldownMillis`).

### Tool surface (v2)

```ts
name: "websearch"
description: `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`
Input: { query: string /* "Websearch query" */ }
Output schema: { provider: ID, results: Result[] }   // Result = {url, title?, content?, time:{published?}}
```

Only `query` is exposed to the model; result count is fixed at 8 per provider. Each
call first goes through the permission system (`websearch` action, query as resource,
`save: ["*"]`).

### Output to the model (v2)

`tool/plugin/websearch.ts:143-153`:

```
## [{title or url}]({url})
Published: {ISO date}          (only if known)

{content}

## [...]
```

joined with blank lines, or
`"No search results found. Please try a different query."` Structured `output` +
`metadata.provider` also returned.

### Search vs fetch

Kept separate. `webfetch` (`tool/plugin/webfetch.ts`, 189 lines) is an independent
tool: `{url, format: text|markdown|html, timeout ≤120}`, browser-ish UA,
Cloudflare-challenge detection, bounded body size, HTML→Markdown. The search
providers already return content excerpts so no search-then-fetch loop is built in.

### Errors

Provider failures are wrapped in `WebSearch.RequestError{providerID, cause}`; the
tool maps HTTP status to messages (`429 → "Web search rate limited (HTTP 429)"`,
`401 → "…authentication failed"`, other → `"Web search request failed (HTTP n)"`,
else `"Unable to search the web for {query}"`) as `ToolFailure`
(`tool/plugin/websearch.ts:157-172`).

### UI

TUI shows `◈ {Provider} Web Search "query"`
(`packages/tui/src/mini/tool.ts:418-424,880-888`), provider comes from tool
`metadata.provider` reported via `context.progress`.

---

## 4. Zero-setup provider candidates — verified

All tests were run from one residential-ish IP on 2026-09-14 with `curl`; a single
success does not prove availability from CI or cloud IPs.

| Candidate                                                                                              | Setup                                                         | Verified?                                                                                                                                                              | ToS / scraping risk                                                                                                                                                                                                                                                                      | Rate limits (source)                                                                                                                                                                                                         | Output quality                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tavily keyless**                                                                                     | None. Header `X-Tavily-Access-Mode: keyless`.                 | ✅ 200 with results, with and without `X-Client-Name`; **401** without the header.                                                                                     | Officially sanctioned: https://docs.tavily.com/documentation/keyless.md ("No account, no API key… Keyless responses are identical to keyed responses").                                                                                                                                  | "free and rate-limited", numbers unpublished; 429 body carries "natural-language instructions". Upgrade path: free key = 1,000 credits/month, no card.                                                                       | Best structured: `title/url/content` (up to 3 ×500-char chunks), plus `time_range`, `include_domains`/`exclude_domains`, `max_results ≤20`, `topic: news`, `include_published_date` all documented in the API reference.                                        |
| **Exa hosted MCP (anonymous)**                                                                         | None. `POST https://mcp.exa.ai/mcp`.                          | ✅ 200 (SSE) with results.                                                                                                                                             | Officially sanctioned: exa-mcp-server README "The hosted MCP server works anonymously with rate limits."                                                                                                                                                                                 | OSS server defaults: **2 QPS and 50 calls/day per IP** (`api/mcp.ts:47-58,155-165` of `exa-labs/exa-mcp-server@15ffb50`); the hosted deployment's actual env values are not public. Bypass with `?exaApiKey=`.               | Good: `Title/URL/Published/Author/Highlights` text blocks; needs regex parsing (as both opencode and pi-web-access do). No domain/recency filters on the basic tool (`web_search_advanced_exa` exists but "not every deployment exposes" it per pi-web-access). |
| **Parallel Search MCP (anonymous)**                                                                    | None.                                                         | ✅ 200; `_meta.parallel/usage` shows `cost_usd: 0.001` charged to their free tier.                                                                                     | Officially sanctioned: https://docs.parallel.ai/integrations/mcp/search-mcp.md "free to use — no API key required, great for exploration and light use".                                                                                                                                 | Free tier rate-limited per `session_id`; anonymous requests forced to `fast` mode; excerpts capped ~25k chars.                                                                                                               | Very good: `structuredContent.results[].{url,title,publish_date,excerpts[]}` — no text parsing needed.                                                                                                                                                          |
| **Firecrawl MCP keyless**                                                                              | None.                                                         | ✅ 200 (SSE).                                                                                                                                                          | Officially sanctioned: https://docs.firecrawl.dev/mcp-server/keyless.md ("Keyless MCP is rate limited and exposes Search, Scrape, and Parse").                                                                                                                                           | Unpublished.                                                                                                                                                                                                                 | Weakest content: `description` is a short page excerpt; no dates.                                                                                                                                                                                               |
| **TinyFish keyless**                                                                                   | Header `X-TinyFish-Access-Mode: keyless`.                     | ✅ 200.                                                                                                                                                                | I could not find the keyless header in TinyFish's public docs (`docs.tinyfish.ai/mcp-integration`); it is only evidenced by opencode's code/tests. Treat as undocumented.                                                                                                                | Unknown.                                                                                                                                                                                                                     | `title/url/snippet/site_name/date` — SERP-style.                                                                                                                                                                                                                |
| **DuckDuckGo HTML** (`html.duckduckgo.com/html/`)                                                      | None.                                                         | ⚠️ `html` endpoint returned 200 with 10 parseable results; **`lite.duckduckgo.com` returned HTTP 202 with an "anomaly"/CAPTCHA challenge page** for the same query/UA. | Scraping; not an API. DDG's Terms require compliance with an Acceptable Use Policy whose text I could not retrieve (page is JS-rendered). The CAPTCHA response is direct evidence of anti-bot enforcement. pi-web-access keeps it explicit-only and out of auto routing for this reason. | Unknown, IP-based, changes without notice.                                                                                                                                                                                   | Title/URL/snippet only; HTML structure (`.result__a`, `uddg` redirect param) can change at any time.                                                                                                                                                            |
| **SearXNG public instances**                                                                           | None, but need an instance URL.                               | ❌ Of 5 public instances tried: 2 returned HTML instead of JSON (`format=json` disabled, the SearXNG default), 3 returned **429** or timed out.                        | Public instances usually forbid API/bot use; self-hosting is the supported path (that's how pi-web-access uses it).                                                                                                                                                                      | Instance-dependent.                                                                                                                                                                                                          | Good when self-hosted (`results[].{title,url,content}`, `time_range`, engines), but self-hosting ≠ zero setup.                                                                                                                                                  |
| **Jina `s.jina.ai`**                                                                                   | Key required.                                                 | ❌ **401 `AuthenticationRequiredError`** without a key.                                                                                                                | https://docs.jina.ai/ : "all API's require authorization using the bearer token"; the GitHub README's "free" wording is stale relative to the live API.                                                                                                                                  | 100 RPM with a key (docs.jina.ai).                                                                                                                                                                                           | Excellent (fetches top-5 page contents), but not zero-setup.                                                                                                                                                                                                    |
| **Brave Search API**                                                                                   | Signup + key.                                                 | Not tested (needs key).                                                                                                                                                | Official API.                                                                                                                                                                                                                                                                            | $5 free credits/month (= ~1,000 searches at $5/1k) per https://brave.com/search/api/; "50 queries per second". A card/account is required for the dashboard (not verified whether a card is mandatory for the free credits). | Excellent SERP JSON; `freshness`, `count`, Goggles.                                                                                                                                                                                                             |
| **Provider-native (Anthropic `web_search_20250305`, OpenAI Responses `web_search`, Gemini grounding)** | Reuses the model's existing credentials — zero _extra_ setup. | Not re-tested; pi-web-search does exactly this.                                                                                                                        | Official.                                                                                                                                                                                                                                                                                | Provider billing per search (e.g. Anthropic bills per web search call in addition to tokens).                                                                                                                                | Returns an LLM-synthesised answer with citations rather than raw results; only works when the active model is a supporting provider; pi-web-search's own `renderResult` hides the answer when collapsed because it is long.                                     |

Additional empirical note: from this IP, all five opencode providers answered a
single query within a few seconds; none returned 429 on first call.

---

## 5. Comparison and recommendation

### What the three projects converge on

- **Tool name / input**: all three expose `query: string`; opencode v2 exposes
  _nothing else_. pi-web-access's `numResults`, `recencyFilter`, `domainFilter` are
  the only widely useful extras and map cleanly onto Tavily's
  `max_results`/`time_range`/`include_domains`/`exclude_domains`.
- **Output**: a Markdown list of `title`, `url`, and a content excerpt is what the
  model consumes best (opencode v2's `## [title](url)\n\ncontent`). Avoid
  pi-web-search's "LLM answer" shape — it hides the raw evidence.
- **Search and fetch stay separate** (opencode, pi-web-search); pi-web-access's
  background-fetch + cache is its most complex feature and is what makes the
  extension 30 k lines. We already have `web_fetch`; the model can chain them.
- **Keyless by default, key optional**: opencode v2's pattern — send the request
  anonymously, attach `Authorization` only if a key is configured — is the right
  shape for "very little or no setup".
- **429 handling**: treat 429 as a distinct, user-actionable error ("add an API key
  for higher limits"), honour `Retry-After`. Don't silently retry.

### Ranked recommendation for a single first provider

1. **Tavily keyless** (`POST https://api.tavily.com/search`, header
   `X-Tavily-Access-Mode: keyless`).
   - Zero setup and _officially documented_ as such, with an explicit, no-card
     upgrade path (free key → `Authorization: Bearer`, identical response schema, so
     the plugin just adds a header when `TAVILY_API_KEY` is set).
   - Plain JSON over REST — no MCP/SSE framing and no regex parsing of text blocks,
     so the Effect implementation is ~the same size as `fetch.ts`
     (`HttpClientRequest.post` + `schemaBodyJson` +
     `HttpClientResponse.schemaBodyJson`).
   - Richest documented parameter surface among the keyless options
     (`max_results ≤20`, `time_range`, `include_domains`/`exclude_domains`, `topic`,
     `include_published_date`), so the tool schema can offer `numResults`, `recency`,
     `domains` without provider-specific hacks.
   - Already the provider opencode's own docs use in their example
     (`TAVILY_API_KEY=your-key opencode`).
   - Risk: keyless rate limits are unpublished; mitigate with the 429 message.
2. **Exa hosted MCP** — equally zero-setup and sanctioned, and it is what both pi
   extensions and opencode v1 default to; but the anonymous quota in the OSS server
   config is small (2 QPS / 50 per day per IP), the response is SSE-wrapped JSON-RPC
   carrying a text blob that must be regex-parsed, and the basic tool has no filters.
   Good second provider or fallback.
3. **Parallel Search MCP** — best structured output and sanctioned free tier, but MCP
   framing, a `session_id`-based limiter, and a per-call USD cost visible in `_meta`
   suggest the free tier is meant for "exploration".
4. **Provider-native search via the active model** (pi-web-search's approach) — zero
   extra credentials, but output is an LLM answer, coverage depends on the current
   model, and each search is billed by the LLM vendor. Worth a later optional
   provider, not the default.
5. **Firecrawl / TinyFish keyless** — work today, but weaker snippets (Firecrawl) or
   undocumented header (TinyFish).
6. **DuckDuckGo HTML scraping** — no API, CAPTCHA observed on the lite endpoint
   during this research, fragile selectors, ToS-grey. Not recommended as the first
   provider even though it needs nothing.
7. **Jina `s.jina.ai`**, **Brave**, **SearXNG public** — all require a key or
   self-hosting in practice; disqualified by the "no signup" constraint.

### Suggested shape for the plugin (derived from the above)

- `name: 'web_search'`, description in the opencode v2 style ("Search the web…
  current year is …"), `promptSnippet` one-liner like `web_fetch`.
- Params: `query` (required), `numResults` (1–20, default 5–8),
  `recency?: 'day'|'week'|'month'|'year'`, `domains?: string[]` (with `-` prefix for
  exclude, as pi-web-access does) — all optional and all mapping 1:1 to Tavily
  fields.
- Output: `## [title](url)\n{content}` blocks (+ `Published:` when
  `include_published_date` is on), `No search results found…` on empty,
  `truncateHead` + `formatTruncationNotice` like `web_fetch`.
- Config: `TAVILY_API_KEY` env (and/or the shared `loadExtensionConfig` from
  `@pi-plugins/shared/config`) → Bearer header; otherwise the keyless header.
- Errors: 429 → "rate limited — set TAVILY_API_KEY for higher limits"; 401 → key
  invalid; timeout 25–30 s via `Effect.timeoutOrElse`; do **not** `retryTransient` on
  429 (opencode only retries by switching provider).
- `renderResult`: header `✓ "query" (N results)` + `ExpandableText` of the result
  list, mirroring `web_fetch`'s `renderResult`.
