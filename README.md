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

## Nix

This repo contains a Nix flake. It builds each plugin as a package and ships a
Home Manager module for declarative installs.

### Build a plugin

```bash
# A single plugin
nix build github:k3dom/pi-plugins#webfetch

# Every plugin at once
nix build github:k3dom/pi-plugins
```

### Home Manager

Add the flake as an input and import the module. Each plugin you enable is
symlinked into `~/.pi/agent/extensions/<name>` for pi-agent to discover — no
manual `pi install` step needed.

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";
    pi-plugins = {
      url = "github:k3dom/pi-plugins";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = {nixpkgs, home-manager, pi-plugins, ...}: {
    homeConfigurations."alice" = home-manager.lib.homeManagerConfiguration {
      pkgs = nixpkgs.legacyPackages.x86_64-linux;
      modules = [
        pi-plugins.homeModules.default
        {
          programs.pi.plugins = {
            # Enable each plugin by its name. Add more the same way, e.g.
            # `othername.enable = true;`, to enable several at once.
            webfetch.enable = true;
          };
        }
      ];
    };
  };
}
```

## License

[MIT](LICENSE)
