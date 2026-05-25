{
  pkgs,
  src,
}: let
  mkPlugin = import ./mk-plugin.nix {inherit pkgs src;};

  exit = mkPlugin {
    packagePath = "plugins/exit";
    pnpmWorkspaces = [
      "@pi-plugins/exit"
    ];
    hash = "sha256-AAExMFo4bmNwXp8YM8bDHDXMi3d9U4L0Nwr+nhtl5jU=";
  };

  webfetch = mkPlugin {
    packagePath = "plugins/webfetch";
    pnpmWorkspaces = [
      "@pi-plugins/webfetch"
      "@pi-plugins/shared"
    ];
    hash = "sha256-wem4JKz4KSj4sYtqv/J8Er9c7+vwDShHE4QP81i2AR8=";
  };
in {
  inherit exit webfetch;

  # All plugins keyed by extension name, so the whole set can be linked at
  # ~/.pi/agent/extensions in one go.
  default = pkgs.linkFarm "pi-plugins" [
    {
      name = "exit";
      path = exit;
    }
    {
      name = "webfetch";
      path = webfetch;
    }
  ];
}
