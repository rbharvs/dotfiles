# dotfiles

A small, opinionated Nix-first baseline for my Apple Silicon Macs. Keep tools
pinned, configuration understandable, and the setup easy to change.

## Structure

| Location | Purpose |
| --- | --- |
| [`flake.nix`](flake.nix), `flake.lock` | Dependency sources, version pins, module composition, and checks |
| [`modules/darwin.nix`](modules/darwin.nix) | Installed software and macOS preferences |
| [`modules/home.nix`](modules/home.nix) | User-file links and Pi settings initialization |
| [`modules/starship.nix`](modules/starship.nix) | Shell prompt |
| `home/` | Authored shell, terminal, keyboard, and home-directory configuration |
| `agents/` | Shared instructions, skills, and Pi customizations |

Personal and work repositories independently consume this baseline and supply
machine profiles and private preferences. The public configuration evaluates on
its own using the fictional account in [`examples/mac.nix`](examples/mac.nix).

Determinate manages Nix and its daemon. nix-darwin manages macOS configuration;
Home Manager manages user configuration. Packages come from Nixpkgs and the
upstream flakes declared in `flake.nix`. Homebrew supplies selected macOS apps.

## Configuration ownership

Authored user files link live to the checkout specified by `dotfiles.checkout`.
Edits take effect when an application reads or reloads them. Keep that checkout
available and compatible with the private profile's pinned modules: the live
files follow the checkout even when the private lockfile pins an older revision.
Declare additional linked resources in `modules/home.nix`.

Herdr's skill links to its pinned upstream source in the Nix store, not this
checkout. Updating the Herdr input updates its executable and unmodified skill
together on activation.

Karabiner's directory is linked because its UI replaces individual files. Review
UI-authored configuration changes before committing; generated backups are ignored.

Pi receives a copy of [`settings.starter.json`](agents/pi/settings.starter.json)
when its local settings file is absent. Subsequent settings changes, model overrides,
credentials, trust decisions, sessions, and caches stay in Pi's local directory.
Existing files and symlinks are preserved during activation.

Each project owns its language versions and dependencies. Use its existing tooling
first, then `nix run` or `nix shell --command` for occasional tools. For example:

```bash
nix shell nixpkgs#postgresql --command psql --version
```

## Private profiles

A downstream flake supplies the account and public-checkout path:

```nix
{
  inputs.dotfiles.url = "github:rbharvs/dotfiles";
  outputs = { dotfiles, ... }: {
    darwinConfigurations.mac = dotfiles.lib.mkMac [
      {
        dotfiles.username = "example";
        dotfiles.checkout = "/Users/example/Developer/dotfiles";
      }
      ./personal.nix
    ];
  };
}
```

The downstream lockfile pins the baseline revision. Machine-specific applications,
assets, and services belong in that downstream configuration.

## Validation

Requires Determinate Nix and Apple's Command Line Tools. From this checkout:

```bash
nix flake check path:. --no-write-lock-file
```

This builds the public example and runs the extension tests and typechecking.
To run just the extension checks:

```bash
nix build path:.#checks.aarch64-darwin.extensions --no-link --no-write-lock-file
```

Test dependencies are pinned in the extension package lockfile and installed inside
the Nix build. Tests use temporary data and mocked services. Live provider calls
and Herdr operations require separate approval.

The `path:` form includes new uncommitted files; Git-flake evaluation includes
files known to Git. **Never activate the fictional `example` profile.** Build and
activate the real host from its private repository.

## Updates and activation

Update the relevant flake input, review the lockfile, and run checks in this repo
and every affected private profile. Pi's executable is updated through its flake
input; `pi update --models` refreshes its local model catalog.

Activation requires approval. Homebrew cleanup uses **`zap`**: it removes installed
Homebrew packages absent from the combined configuration, including formerly
declared packages. Cask cleanup rules can also remove preferences and application
data. Review the full inventory and removal effects before switching.

Keep state-version values across upgrades. Keep credentials and runtime data outside
Git and Nix inputs, including private repos: flake sources enter the locally readable
Nix store. Back up application data, Keychain items, and other machine-local state
separately; Nix rollback does not restore them or undo every activation side effect.

## Licenses

Original material is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md)
for vendored material and local font requirements.
