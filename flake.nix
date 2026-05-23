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
        runtimeInputs = with pkgs; [nodejs_24 corepack turbo];
        text = ''
          export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

          pnpm install --frozen-lockfile
          turbo run format:check lint check-types build test
        '';
      };
    in {
      default = pkgs.mkShell {
        packages = with pkgs; [
          nodejs_24
          corepack
          turbo

          statix
          zizmor

          ci
        ];
      };
    });
    formatter = eachSupportedSystem ({pkgs}: pkgs.alejandra);
  };
}
