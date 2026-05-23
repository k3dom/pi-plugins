{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.pi.plugins;
in {
  options.programs.pi.plugins.webfetch.enable = lib.mkEnableOption "the @pi-plugins/webfetch pi extension";

  config = lib.mkIf cfg.webfetch.enable {
    home.file.".pi/agent/extensions/webfetch".source =
      self.packages.${pkgs.stdenv.hostPlatform.system}.webfetch;
  };
}
