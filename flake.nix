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
        runtimeInputs = with pkgs; [nodejs_24];
        text = ''
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

          corepack pnpm install --frozen-lockfile
          corepack pnpm format:check
          corepack pnpm lint
          corepack pnpm check-types
          corepack pnpm build
          corepack pnpm test
        '';
      };
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          # Node.js 24 still includes corepack; later versions will drop corepack.
          nodejs_24

          statix
          zizmor

          ci
        ];
      };
    });
    formatter = eachSupportedSystem ({pkgs}: pkgs.alejandra);
  };
}
