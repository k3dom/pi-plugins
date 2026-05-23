{
  description = "pi-agent plugins monorepo";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
  outputs = {nixpkgs, ...}: let
    eachSupportedSystem = f:
      nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed (
        system:
          f {
            pkgs = import nixpkgs {inherit system;};
          }
      );
  in {
    devShells = eachSupportedSystem ({pkgs}: let
      ci = pkgs.writeShellApplication {
        name = "ci";
        runtimeInputs = with pkgs; [nodejs_24 corepack];
        text = ''
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

          pnpm install --frozen-lockfile
          pnpm format:check
          pnpm lint
          pnpm check-types
          pnpm build
          pnpm test
        '';
      };
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          # Node.js 24 still includes corepack; later versions will drop corepack.
          nodejs_24
          # Provides package-manager shims such as pnpm without mutating the Nix store.
          corepack

          statix
          zizmor

          ci
        ];
      };
    });
    formatter = eachSupportedSystem ({pkgs}: pkgs.alejandra);
  };
}
