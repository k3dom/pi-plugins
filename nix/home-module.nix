{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi-plugins;
in {
  options.programs.pi-plugins = {
    exit.enable = lib.mkEnableOption "the @pi-plugins/exit pi extension";
    webfetch.enable = lib.mkEnableOption "the @pi-plugins/webfetch pi extension";
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.exit.enable {
      home.file.".pi/agent/extensions/exit".source =
        self.packages.${pkgs.stdenv.hostPlatform.system}.exit;
    })
    (lib.mkIf cfg.webfetch.enable {
      home.file.".pi/agent/extensions/webfetch".source =
        self.packages.${pkgs.stdenv.hostPlatform.system}.webfetch;
    })
  ];
}
