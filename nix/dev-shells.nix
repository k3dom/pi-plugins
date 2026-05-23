{pkgs}: let
  ci = pkgs.writeShellApplication {
    name = "ci";
    runtimeInputs = with pkgs; [
      nodejs_24
      corepack
      turbo
    ];
    text = ''
      export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

      pnpm install --frozen-lockfile
      turbo run format:check lint check-types build
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
}
