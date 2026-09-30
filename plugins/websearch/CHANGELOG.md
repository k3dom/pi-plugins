# @pi-plugins/websearch

## 0.2.0

### Minor Changes

- a5bf0ca: Declare an output schema for `web_search` and return the results as structured
  content. Codemode scripts now receive `{ results: [{ title, url, content, publishedAt? }] }`
  instead of the Markdown text.

## 0.1.1

### Patch Changes

- 8a8e5c8: Bundle Effect into the extension instead of depending on it at runtime. npm could
  resolve two incompatible Effect versions into the install tree, which either failed
  to load the extension or warned `Ignoring invalid <name> config: TypeError` on every
  startup.

## 0.1.0

### Minor Changes

- 68c6816: Add the `web_search` tool. Searches run through Tavily's keyless mode with no setup;
  set `TAVILY_API_KEY` to use an API key instead. Results are returned as a Markdown
  list of title, URL, publish date and a short content excerpt.
