{
  config,
  lib,
  pkgs,
  herdr,
  herdrSource,
  dotfilesCheckout,
  ...
}:
let
  live = relative: config.lib.file.mkOutOfStoreSymlink "${dotfilesCheckout}/${relative}";
  extensions = [
    "statusline.ts"
    "anthropic-web"
    "run-and-notify"
  ];
  skills = [
    "alignment"
    "code-review"
    "librarian"
  ];
in
{
  imports = [ ./starship.nix ];
  home.stateVersion = "26.05";
  home.file = {
    "AGENTS.md".source = live "home/AGENTS.md";
    ".zshrc".source = live "home/.zshrc";
    ".config/ghostty/config".source = live "home/.config/ghostty/config";
    ".config/herdr/config.toml".source = live "home/.config/herdr/config.toml";
    # Karabiner replaces individual file symlinks when saving, so link the directory.
    ".config/karabiner".source = live "home/.config/karabiner";
    ".agents/skills/herdr".source = "${herdrSource}/skills/herdr";
    ".agents/skills/agent-browser".source = "${pkgs.agent-browser}/skills/agent-browser";
    ".pi/agent/AGENTS.md".source = live "agents/AGENTS.md";
    ".pi/agent/themes/rose-pine.json".source = live "agents/pi/themes/rose-pine.json";
  }
  // lib.listToAttrs (
    map (name: {
      name = ".pi/agent/extensions/${name}";
      value.source = live "agents/pi/extensions/${name}";
    }) extensions
  )
  // lib.listToAttrs (
    map (name: {
      name = ".agents/skills/${name}";
      value.source = live "agents/skills/${name}";
    }) skills
  );

  # Pi owns mutable settings and runtime state.
  # Preserve existing files, including empty files and dangling symlinks.
  home.activation.seedPiSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    settings=${lib.escapeShellArg "${config.home.homeDirectory}/.pi/agent/settings.json"}
    if [[ ! -e "$settings" && ! -L "$settings" ]]; then
      run ${pkgs.coreutils}/bin/install -D -m 600 \
        ${../agents/pi/settings.starter.json} "$settings"
    fi
  '';

  # Herdr writes its Pi integration beside the authored extensions.
  home.activation.installHerdrPiIntegration = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    run env -u PI_CODING_AGENT_DIR HOME=${lib.escapeShellArg config.home.homeDirectory} \
      ${herdr}/bin/herdr integration install pi
  '';
}
