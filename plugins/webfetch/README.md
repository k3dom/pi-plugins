# `@pi-plugins/webfetch`

A [pi-agent](https://github.com/earendil-works/pi) extension that registers a
`web_fetch` tool for fetching content over HTTP(S).

## Install

```bash
pi install npm:@pi-plugins/webfetch
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/webfetch
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/webfetch
```

## Tool: `web_fetch`

The tool fetches a URL and returns its content as Markdown (the default) or raw HTML.
Requests are sent with browser-like headers and transient failures are retried.

### Inputs

| Parameter | Type                   | Required | Default      | Description                              |
| --------- | ---------------------- | -------- | ------------ | ---------------------------------------- |
| `url`     | `string`               | yes      | —            | The URL to fetch content from.           |
| `format`  | `'markdown' \| 'html'` | no       | `'markdown'` | The format to return the content in.     |
| `timeout` | `number`               | no       | `30`         | Timeout in seconds (min `1`, max `120`). |

### Output

Returns the page content as text. With `format: 'markdown'`, HTML pages are converted
to Markdown; non-HTML responses are returned unchanged. With `format: 'html'`, the
raw response body is returned.

Long content is truncated from the head to fit the tool's output budget. When this
happens the text ends with a note such as:

```
[Truncated to 500 of 1234 lines]
```

The tool result also carries a `details.truncated` boolean indicating whether
truncation occurred.
