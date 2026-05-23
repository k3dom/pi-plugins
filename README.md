# pi-plugins

High-quality, single-purpose plugins for the [pi-agent](https://github.com/earendil-works/pi)
harness, built on [Effect-TS](https://effect.website) primitives.

Each plugin does one thing well: clear inputs, predictable outputs, and an
implementation that leans on Effect for typed errors, resource safety, and
composable concurrency.

## Packages

| Package                        | Description                                                            | Tools       |
| ------------------------------ | ---------------------------------------------------------------------- | ----------- |
| [`webfetch`](plugins/webfetch) | Fetches content over HTTP(S) and returns them as Markdown or raw HTML. | `web_fetch` |

## Usage

Install a published plugin with pi-agent:

```bash
pi install npm:@pi-plugins/webfetch
```

Or try it for a single run without adding it to settings:

```bash
pi -e npm:@pi-plugins/webfetch
```

For local development, load a plugin directly from its package directory:

```bash
pi -e ./plugins/webfetch
```

Then ask pi to use the tool it registers — for example, to fetch a URL.

## License

[MIT](LICENSE)
