{
  description = "pi-agent plugins monorepo";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };
  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    inherit (nixpkgs) lib;
    eachSupportedSystem = f:
      lib.genAttrs lib.systems.flakeExposed (
        system:
          f {
            pkgs = import nixpkgs {inherit system;};
          }
      );

    # Whole monorepo, minus build artifacts and VCS noise. Used both to read
    # the pnpm lockfile and as the build source, so filtering keeps Nix from
    # rebuilding on irrelevant churn.
    src = lib.cleanSourceWith {
      src = ./.;
      filter = path: type:
        !(builtins.elem (baseNameOf path) [
          "node_modules"
          "dist"
          ".turbo"
          ".direnv"
          ".git"
          "result"
          ".wt"
        ]);
    };
  in {
    homeModules.default = import ./nix/home-module.nix {inherit self;};
    packages = eachSupportedSystem ({pkgs}: import ./nix/packages {inherit pkgs src;});
    devShells = eachSupportedSystem ({pkgs}: import ./nix/dev-shells.nix {inherit pkgs;});
    formatter = eachSupportedSystem ({pkgs}: pkgs.alejandra);
  };
}
