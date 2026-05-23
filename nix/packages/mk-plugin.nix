{
  pkgs,
  src,
}: {
  # Path to the plugin's workspace, e.g. "plugins/webfetch". Used to read the
  # manifest for pname/version/meta.
  packagePath,
  # Workspace subgraph fetched for this plugin (the plugin plus any workspace
  # deps it bundles at build time). Scopes the offline dep fetch.
  pnpmWorkspaces,
  # fetchPnpmDeps fixed-output hash. Bump when pnpm-lock.yaml or the scoped
  # workspace set changes.
  hash,
}: let
  inherit (pkgs) lib;
  manifest = lib.importJSON "${src}/${packagePath}/package.json";
  filter = manifest.name;
in
  pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
    pname = "pi-plugin-${baseNameOf packagePath}";
    version = manifest.version;
    inherit src;

    nativeBuildInputs = [
      pkgs.nodejs_24
      pkgs.pnpm_11
      pkgs.pnpmConfigHook
    ];

    pnpm_config_manage_package_manager_versions = "false";
    inherit pnpmWorkspaces;
    pnpmDeps = pkgs.fetchPnpmDeps {
      inherit
        (finalAttrs)
        pname
        version
        src
        pnpmWorkspaces
        ;
      pnpm = pkgs.pnpm_11;
      fetcherVersion = 3;
      inherit hash;
    };

    buildPhase = ''
      runHook preBuild

      pnpm --filter ${filter} build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      deploy="$TMPDIR/deploy"
      rm -rf "$deploy"
      # hoisted = flat, npm-style node_modules. pi resolves the logical
      # (non-real) module path via jiti, which can't follow pnpm's symlinked
      # .pnpm store layout, so deploy a flat tree. --prod drops the peer deps
      # (@earendil-works/*, typebox) that pi injects as virtual modules.
      pnpm \
        --config.node-linker=hoisted \
        --config.inject-workspace-packages=true \
        --filter ${filter} \
        deploy --prod --offline "$deploy"

      mkdir -p "$out"
      # Dereference symlinks so $out has no links into the pnpm store.
      cp -aL "$deploy"/. "$out"/

      runHook postInstall
    '';

    meta = {
      description = manifest.description or "";
      homepage = manifest.homepage or "";
      license = lib.licenses.mit;
    };
  })
