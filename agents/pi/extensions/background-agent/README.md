# Background agent

Runs reusable child Pi sessions in background Herdr tabs. Requires the Herdr CLI,
Herdr's pane/workspace environment, and a persisted parent Pi session.

## Tools

- `background_agent` starts a child session or sends a follow-up to a settled one.
- `background_agent_result` collects a persisted result by run ID.

A session has one active run. Follow-ups retain its model, thinking level, working
directory, and tool set. Delegation permits two levels: parent → child →
grandchild. Children inherit active delegation tools; grandchildren do not.
`MAX_DELEGATION_DEPTH` in `core.ts` sets the limit. `PI_BACKGROUND_AGENT_DEPTH`
tracks the current level, starting at zero. The limit bounds nesting, not the
number of concurrent agents.

Completion is asynchronous. Continue other work until the completion notification,
then collect the result. Results use Pi's tool-output limits; truncated results
include the child transcript path for the full answer.

## State and recovery

A follow-up requires the parent's current trust decision to match the child's saved
decision. The child transcript must match the revision observed by the active parent
branch. A bounded tail of `session_info` and standalone `usage` entries can safely
advance that revision. Other changes require a new child session.

Herdr supplies lifecycle status. `idle` and `done` permit result extraction;
`blocked` and backend failures fail the run. An `unknown` status receives one bounded
stabilization check. Transcript-content failures after confirmed settlement can
retain a resumable revision when the transcript's identity and size are valid.
Missing-agent, wait, and missing-transcript failures require a new session.

The extension saves the answer and transcript revision before notifying the parent.
Cleanup closes its own tab after verifying ownership. Recovery requires a fresh
Herdr lookup proving the stored agent, tab, pane, workspace, and child-session
identity; inconclusive ownership leaves the tab open.

State follows Pi's active conversation branch, including tree navigation. Live
runs on that branch retain their completion notifications. Process-start recovery
is silent and resumes monitoring or result collection without replaying prompts.
Saved results lacking a resumable revision remain available for collection.

## Display

Rows show the child's semantic session name when available, with its session handle
as the fallback. Collapsed rows preview the prompt or result; Ctrl+O expands them.
Errors stay fully visible. Tool calls and result collection use stable session and
run identifiers.

## Development

Run the repository's [extension checks](../../../../README.md#validation), then
reload Pi with `/reload` after edits.

The live smoke test creates real Herdr tabs and makes paid model requests. It
requires explicit approval, a Herdr session, and access to the model selected in
[`test/live-smoke.mjs`](test/live-smoke.mjs). From the repository root:

```bash
nix shell --inputs-from path:. nixpkgs#nodejs_22 --command \
  npm --prefix agents/pi/extensions/background-agent run test:live
```
