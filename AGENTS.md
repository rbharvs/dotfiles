# Dotfiles agent guide

Read [README.md](README.md) for configuration ownership, validation commands, and
activation hazards. Keep this Apple Silicon baseline small and easy to change.

## Changes

- Inspect Git status and preserve unrelated work. Use the primary checkout for
  sequential tasks and ordinary worktrees for parallel or isolated changes.
- Edit tracked sources. Live-linked files can affect running applications as soon
  as they are read or reloaded.
- Keep private profiles, personal assets, private input references, credentials,
  and runtime state out of the public tree and lockfile. Public evaluation must
  remain independent of private inputs.
- Preserve existing local Pi settings when seeding a new installation.
- Use maintained Nix packages or upstream flakes first, with one installation
  owner per tool. Update Pi through Nix. Preserve each project's existing tooling.
- Keep Determinate's daemon ownership (`nix.enable = false`) and existing state
  versions. Add automation only for a concrete repeated need.

## Verification and approval

Run the README's checks and build affected private profiles. Extension checks must
cover behavior and typecheck against the pinned Pi API. Live provider calls and
Herdr operations require explicit approval. The public example is build-only.

Require explicit approval before activation, commits, remote changes, pushes, or
publication. Review the combined Homebrew inventory and zap cleanup effects before
activation. Keep independent backups of application data affected by activation.

Before public commits, audit the selected files and Git metadata for private data
and proprietary material, verify the effective Git identity, and preserve the
[third-party notices](THIRD_PARTY_NOTICES.md).
