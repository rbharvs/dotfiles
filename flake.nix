{
  description = "A small, Nix-first macOS workstation baseline";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
    nix-darwin.url = "github:nix-darwin/nix-darwin/nix-darwin-26.05";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    home-manager.url = "github:nix-community/home-manager/release-26.05";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    herdr.url = "github:herdrdev/herdr/v0.9.5";
    pi.url = "github:earendil-works/pi/v1.3.0";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      nix-homebrew,
      ...
    }:
    let
      system = "aarch64-darwin";
      pkgs = nixpkgs.legacyPackages.${system};
      lib = nixpkgs.lib;
      herdr = inputs.herdr.packages.${system}.default;
      pi = inputs.pi.packages.${system}.pi;
    in
    {
      darwinModules.default = {
        imports = [
          ./modules/darwin.nix
          nix-homebrew.darwinModules.nix-homebrew
          home-manager.darwinModules.home-manager
        ];
        _module.args = { inherit herdr pi; };
        home-manager.sharedModules = [ self.homeModules.default ];
        home-manager.extraSpecialArgs = {
          inherit herdr;
          herdrSource = inputs.herdr;
        };
      };
      homeModules.default = import ./modules/home.nix;

      lib.mkMac =
        modules:
        nix-darwin.lib.darwinSystem {
          modules = [ self.darwinModules.default ] ++ modules;
        };

      darwinConfigurations.example = self.lib.mkMac [ ./examples/mac.nix ];
      formatter.${system} = pkgs.nixfmt;
      checks.${system} = {
        example = self.darwinConfigurations.example.system;
        extensions =
          assert
            (lib.importJSON ./agents/pi/extensions/package.json)
            .devDependencies."@earendil-works/pi-coding-agent" == pi.version;
          pkgs.stdenvNoCC.mkDerivation {
            name = "dotfiles-extension-tests";
            src = lib.cleanSourceWith {
              src = ./agents/pi/extensions;
              filter = path: type: builtins.baseNameOf path != "node_modules" && lib.cleanSourceFilter path type;
            };
            npmDeps = pkgs.importNpmLock { npmRoot = ./agents/pi/extensions; };
            nativeBuildInputs = [
              pkgs.nodejs_22
              pkgs.importNpmLock.npmConfigHook
            ];
            npmRebuildFlags = [ "--ignore-scripts" ];
            dontBuild = true;
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm test
              npm run typecheck
              runHook postCheck
            '';
            installPhase = ''touch "$out"'';
          };
      };
    };
}
