# Session naming

Generates short kebab-case names for Pi sessions and synchronizes them with Herdr.

## Naming behavior

- An unnamed session receives a name from its effective active-branch context.
- Forked and cloned sessions receive a fresh name from the fork boundary.
- Launchers can request fresh naming once with `PI_SESSION_NAMING_FRESH=1`.
- Existing names from `--name`, `/name`, resume, or reload are otherwise preserved.
- A deterministic keyword fallback handles unavailable models and naming failures.

Naming runs asynchronously through Pi's model registry. The selected model and
request limits are defined in [`core.ts`](core.ts). Name formatting and its prompt
are defined in [`session-naming.ts`](session-naming.ts).

Context comes from Pi's active-branch projection, including effective summaries and
context edits. System messages are excluded. Pi's conversation serializer handles
non-text content and tool-result truncation.

The fresh-name signal is removed from the process environment and treated as
consumed once the session records a post-creation name, including names recorded
off the active branch. This keeps it one-shot across restart and tree navigation.

## Herdr display

Names populate the pane's `$session` metadata token, metadata title, pane label,
and containing tab label. Unnamed sessions clear stale pane metadata and labels
while naming runs. Workspaces and sidebar styling remain Herdr configuration.

When several Pi sessions share a tab, the latest synchronization sets the tab label.
Each pane retains its own session name.

## Development

Run the repository's [extension checks](../../../../README.md#validation).
Run `/reload` in Pi after changing the extension.
