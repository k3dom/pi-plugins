# `@pi-plugins/websearch`

Search the web in [pi](https://github.com/earendil-works/pi) with the `web_search`
tool.

## Install

```bash
pi install npm:@pi-plugins/websearch
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/websearch
```

## Usage

Ask pi to look something up:

```text
Search the web for the latest Effect 4 release notes.
```

Results are returned as a Markdown list of title, URL and a short content excerpt.
Pair it with [`@pi-plugins/webfetch`](../webfetch#readme) to read a result in full.

### Parameters

| Parameter    | Type     | Required | Description                                                     |
| ------------ | -------- | -------- | --------------------------------------------------------------- |
| `query`      | `string` | Yes      | The search query.                                               |
| `maxResults` | `number` | No       | Number of results to return, from `1` to `20`. Defaults to `8`. |

## Notes

Long result lists may be shortened to fit pi's output limit. A notice indicates when
this happens.
