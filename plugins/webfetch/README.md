# `@pi-plugins/webfetch`

Fetch web pages as Markdown or raw HTML in [pi](https://github.com/earendil-works/pi)
with the `web_fetch` tool.

## Install

```bash
pi install npm:@pi-plugins/webfetch
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/webfetch
```

## Usage

Ask pi to fetch a URL:

```text
Fetch https://example.com and summarize the page.
```

Pages are returned as Markdown by default. Ask for raw HTML when you need the page
source.

### Parameters

| Parameter | Type                   | Required | Description                                              |
| --------- | ---------------------- | -------- | -------------------------------------------------------- |
| `url`     | `string`               | Yes      | The HTTP(S) URL to fetch.                                |
| `format`  | `"markdown" \| "html"` | No       | Output format. Defaults to `"markdown"`.                 |
| `timeout` | `number`               | No       | Timeout in seconds, from `1` to `120`. Defaults to `30`. |

## Notes

Long pages may be shortened to fit pi's output limit. A notice indicates when this
happens.
