# Home directory guide

This file describes how to organize and handle data under the home directory. More specific instructions in a project or subdirectory take precedence.

## Principles

Do not impose Linux-style XDG compliance globally on macOS. Let command-line tools use XDG locations when that is their native convention, and let native or macOS-aware applications use `~/Library`.

Before moving, deleting, or deciding whether to back up data, determine:

- whether it is authored or generated;
- whether it contains secrets or private information;
- whether it must be backed up;
- whether it can be reconstructed or recovered from a remote source;
- whether it is safe to delete.

Location alone does not answer these questions.

## Directory roles

- `~/Developer` contains source repositories and technical project work.
  - Canonical, active repositories may live directly under `~/Developer`.
  - `~/Developer/worktrees/<repo>/<task>` contains linked Git worktrees.
  - `~/Developer/external` contains third-party repositories checked out for inspection or use.
  - `~/Developer/experiments` contains deliberate prototypes that may be retained.
  - `~/Developer/scratch` contains disposable technical work.
  - `~/Developer/archive` contains inactive code retained for reference.
- `~/Archives` contains non-code archives, machine snapshots, and broader historical material.
- `~/Documents` contains durable personal documents.
- `~/Downloads` is temporary intake and should not be treated as durable storage.
- `~/.agents` contains canonical cross-agent instructions and skills exposed by the dotfiles configuration.
- `~/.config` contains configuration for tools that naturally use it.
- `~/.local/bin` contains user executables that are not managed elsewhere.
- `~/.local/share` contains durable CLI data.
- `~/.local/state` contains durable CLI operational state.
- `~/.cache` must contain only disposable, reconstructible data.
- `~/Library` is application-managed space for native and macOS-aware applications. Do not reorganize it merely for consistency with XDG conventions.

## Configuration ownership

The public dotfiles checkout and its private downstream machine profiles are the source of truth for declaratively managed configuration. Follow managed symlinks to find their tracked sources; do not assume a checkout location. Edit those sources rather than generated files.

Do not place secrets, credentials, private keys, caches, generated files, or application backups in the dotfiles repository.

## Changes and migration

Apply this structure incrementally. Do not move existing data solely to make the tree look consistent. Before migration, distinguish unique local data from generated data and content recoverable from a remote source. Inspect dirty or unpushed repositories before moving or archiving them.
