# pi-plugins

High-quality, single-purpose plugins for the [pi-agent](https://github.com/earendil-works/pi)
harness, built on [Effect-TS](https://effect.website) primitives.

Each plugin does one thing well: clear inputs, predictable outputs, and an
implementation that leans on Effect for typed errors, resource safety, and
composable concurrency.

## Packages

| Package                         | Description                                                            | Tools       |
| ------------------------------- | ---------------------------------------------------------------------- | ----------- |
| [`webfetch`](packages/webfetch) | Fetches content over HTTP(S) and returns them as Markdown or raw HTML. | `web_fetch` |

## Usage

Load a plugin into pi-agent directly from its package directory:

```bash
pi -e ./packages/webfetch
```

Then ask pi to use the tool it registers — for example, to fetch a URL.

## License

[MIT](LICENSE)
