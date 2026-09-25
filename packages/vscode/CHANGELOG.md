# Change Log

## [Unreleased]

## [0.5.0] — 2026-09-25

### Added

- **Each AI task can run in its own git worktree (#12).** In a git repository,
  tasks work on their own branches and land on one integration branch per run,
  so tasks that edit the same files no longer overwrite each other. A task card
  marks a merge conflict, with an opt-in "Resolve as a task" action, and the
  task details show its branch and worktree. Uncommitted changes open a prompt
  to stash them, run without isolation this time, or cancel. At the end of a
  run the handoff card shows the integration branch and the landed tasks, with
  Review diff, Merge, Discard and Clean up. Turn it off with the
  `ordewell.worktreeIsolation` setting; `ordewell.worktreeSetupCommand`
  prepares new worktrees your own way.
- **A folder of git repositories isolates them together (ADR-0014).** Each task
  gets a worktree of every repository at its usual path, and a task lands in
  every repository it changed or in none. The handoff card shows each
  repository, and Merge all merges every one or none, naming the repository
  and reason when it holds back. Pick the repositories with
  `ordewell.workspaceRepos`, and link extra gitignored state such as
  `*.tfstate` into worktrees with `ordewell.worktreeLinks`.
- **Fork, rewind and compact the planner conversation (#9, #10).** `/fork`
  continues in a copy of the conversation, `/rewind` cuts it back to before one
  of your messages, and `/compact` replaces it with a summary the planner
  writes, keeping the last two exchanges. Also in the Command Palette as
  "Ordewell: Fork Conversation", "Ordewell: Rewind Conversation" and
  "Ordewell: Compact Conversation". The task list is left as it is.
- The planner can read a running task's recent output, so it can look at a
  task that seems stuck instead of guessing (#3).

### Fixed

- A task's summary is taken from its own transcript, not from another task
  that ran in the same directory.
- A retry, cancel, Mark complete or stop is no longer overwritten by a verdict
  from the task's previous attempt, and marking a task complete while its
  runner starts is no longer undone.
- Conflict marks and the handoff card come back after a reconnect or a session
  load.

## [0.4.23] — 2026-09-23

### Fixed

- Models added to a runner's allowlist during a session can now be assigned
  by the planner, and clearing the allowlist lifts the restriction right away
  (#17).

## [0.4.22] — 2026-09-23

### Fixed

- Codex tasks added or moved onto Codex now run with full access when
  autonomous mode is on, instead of the workspace-write sandbox. The New Task
  card's mode defaults to "Runner default", which follows the toggle.

## [0.4.21] — 2026-09-22

### Fixed

- A dependent task's context about its predecessors now shows the runner's
  actual final message, cleaned from the terminal's TUI paint (#14), and reads
  the agent's own session transcript when one is available (#16).

## [0.4.20] — 2026-09-22

### Fixed

- An OpenCode task's terminal tab no longer sits with the prompt typed in but
  unsent — it now starts on its own instead of waiting for a manual Enter.

## [0.4.19] — 2026-09-10

### Fixed

- Expanding a task in the plan dock now collapses any other open task, so the
  list stays readable instead of accumulating open cards.

## [0.4.18] — 2026-09-07

### Fixed

- A long OpenCode planning turn no longer fails with "fetch failed" — the
  planner reads the reply back out of the session instead of losing the turn.

### Added

- A third built-in skill, `improve-codebase-architecture` — invoke with
  `/improve-codebase-architecture` to surface deepening opportunities and turn
  the ones you pick into ordered plan tasks.

### Changed

- **The `grill-me` skill is renamed to `grilling`**, invoked as `/grilling`.

## [0.4.2] — 2026-08-02

### Fixed

- **The extension could not start.** `uuid` was left out of the bundle while the
  .vsix ships no `node_modules`, so activation threw `Cannot find module 'uuid'`
  and the panel never rendered. Affects every 0.4.0 install; upgrade.

  The bundler externalises everything in `dependencies` by default, and the
  build only opted `@ordewell/core` back in. Builds now fail if any module is
  left external without being shipped.

## [0.4.1] — 2026-08-02 (unreleased)

### Changed

- Marketplace icon now carries its own background. It was a transparent PNG with
  near-black strokes, so the mark disappeared on every dark background VS Code
  and the Marketplace render it against.
- Marketplace listing: dropped the lead image, which was a mock VS Code window
  drawn around the panel rather than a screenshot of one.
- Corrected the planner setup step — it named the `OPENROUTER_API_KEY` and
  `GEMINI_API_KEY` environment variables as though they were settings. The
  settings are `ordewell.openAiApiKey` and `ordewell.apiKey`.
- Corrected the CLI install: `npm install -g ordewell`, then `ordewell`.

## [0.4.0] — 2026-07-31

First public release.

### Added

- Streaming planner timeline: live thinking, each research step with its
  outcome, and task cards you expand for the runner's own output.
- Editable plan cards — change a task's runner and its model, effort and mode
  re-derive in place.
- Planner bar: choose the planning backend, its model, and thinking effort,
  scoped to what that backend can actually run.
- Harness planners — plan with Claude Code, Codex or OpenCode on a subscription
  you already hold, with no separate API key.
- Evidence-based task verdicts, with *Mark complete* and *Mark not done* for the
  cases the marker can't settle.
- Deep-interview planning modes: grill-me, PRD drafting, TDD augmentation,
  review and verify.
- Windows support.

Full project changelog:
https://github.com/ordewell/ordewell/blob/main/CHANGELOG.md
