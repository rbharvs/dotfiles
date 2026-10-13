{
  config,
  lib,
  pkgs,
  herdr,
  pi,
  ...
}:
let
  cfg = config.dotfiles;
  homeDirectory = "/Users/${cfg.username}";
in
{
  options.dotfiles = {
    username = lib.mkOption {
      type = lib.types.strMatching "[a-z_][a-z0-9_-]*";
      description = "Existing macOS account, supplied by the private machine profile.";
    };
    checkout = lib.mkOption {
      type = lib.types.strMatching "/.+";
      description = "Absolute path to the public checkout used for live authored files.";
    };
  };

  config = {
    # Determinate manages Nix and its daemon.
    nix.enable = false;
    nixpkgs.hostPlatform = "aarch64-darwin";
    nixpkgs.config.allowUnfree = true;
    system.stateVersion = 6;
    system.primaryUser = cfg.username;
    users.users.${cfg.username}.home = homeDirectory;

    security.pam.services.sudo_local.touchIdAuth = true;
    networking.applicationFirewall = {
      enable = true;
      enableStealthMode = true;
      blockAllIncoming = false;
    };
    programs.zsh.shellInit = ''
      # Avoid repeated completion paths in child shells.
      typeset -gU fpath FPATH
    '';
    system.defaults = {
      NSGlobalDomain = {
        AppleInterfaceStyle = "Dark";
        KeyRepeat = 1;
        InitialKeyRepeat = 15;
        AppleShowAllExtensions = true;
        ApplePressAndHoldEnabled = false;
      };
      dock.autohide = true;
      dock.mru-spaces = false;
      finder.FXPreferredViewStyle = "Nlsv";
      finder.CreateDesktop = false;
      screencapture.location = "${homeDirectory}/Downloads";
    };

    environment.systemPackages = [
      pi
      herdr
      pkgs.ghostty-bin
      pkgs.gh
      pkgs.awscli2
      pkgs.ripgrep
      pkgs.jq
      pkgs.uv
      pkgs.ffmpeg
      pkgs.poppler-utils
    ];
    nix-homebrew = {
      enable = true;
      user = cfg.username;
    };
    homebrew = {
      enable = true;
      # Zap can remove application data from undeclared casks.
      onActivation.cleanup = "zap";
      onActivation.autoUpdate = false;
      onActivation.upgrade = false;
      onActivation.extraFlags = [ "--force" ];
      casks = [
        "karabiner-elements"
        "orbstack"
      ];
    };

    home-manager = {
      useGlobalPkgs = true;
      useUserPackages = true;
      extraSpecialArgs.dotfilesCheckout = cfg.checkout;
      users.${cfg.username} = {
        home.username = cfg.username;
        home.homeDirectory = homeDirectory;
      };
    };
  };
}
