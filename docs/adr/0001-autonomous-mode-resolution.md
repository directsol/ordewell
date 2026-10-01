# 0001 — Autonomous mode resolution

**Status:** accepted

## Problem

Generating a plan means picking a runner mode per task — Claude's
`default`/`acceptEdits`/`bypassPermissions`, OpenCode's `build`/`plan`, Codex's
own set. Three things made that hard to just ask the planner to do:

- Mode names are runner-specific, and the conventions disagree. OpenCode has no
  mode safer than `build`; Codex differs again.
- The planner was observed defaulting to the least autonomous mode
  (`default`/"ask before edits"). Reading the prompt afterwards, the cause was
  plain: the mode list anchored on whatever came first, and the autonomous
  mode's own description ("use only when you don't need supervision") was
  scaring it off.
- We did not want a global toggle that silently rewrites plans after the fact.
  What the plan says is what runs, or the plan stops being worth reviewing.

## Decision

Mode resolution is **planner-nudged, parser-validated, never runtime-overridden**, driven by **symmetric manifest tags** (`autonomous` / `safe`) and a **global user toggle** (`ordewell.autonomousMode`, default ON, surfaced via `/auto`).

Concretely:

- **The plan is the source of truth.** The toggle is read only at generation
  time; the orchestrator never replaces `task.taskMode` at spawn. A user who
  flips the toggle after generating sees no change until they regenerate. That
  is deliberate — it is the same rule `/model set` follows.
- **Manifests declare what autonomy means for that runner.** Core never
  hardcodes mode IDs. Each manifest tags one mode `autonomous: true` and one
  `safe: true`. OpenCode's `build` wears both tags — an honest no-op, since
  OpenCode has nothing safer than build, rather than a mystery.
- **The planner is steered, not coerced.** `buildModeGuide` names the resolved
  default per runner explicitly, lists the autonomous mode first, and says
  "default to this unless the task specifically needs more caution." The parser
  only intervenes on invalid emissions; its fallback picks the
  `autonomous`/`safe`-tagged mode per the toggle. The planner keeps portfolio
  judgment — it may still pick a more conservative mode for a task it judges
  risky.
- **`plan` mode stays valid but is steered away from** for build-style tasks.
  The parser never rewrites it; the guide simply does not point the planner at
  it. Manual per-task override in the UI wins under every toggle state.

## Alternatives considered

- **Runtime override** — toggle rewrites modes at spawn, including on
  already-generated plans. Rejected: it makes "what the plan says" differ from
  "what runs", which is the exact silent state this project refuses to create.
  It also erases the planner's per-task judgment.
- **Hard parser override** — toggle forces every non-plan AI task to the
  autonomous mode at parse time, ignoring what the planner emitted. Rejected
  for the same reason plus a concrete artifact: the plan JSON would show a mode
  the planner did not emit, with no signal why.
- **Per-runner toggle** (`ordewell.autonomousByRunner`). Rejected: manifest
  tags already absorb runner heterogeneity; a per-runner map adds state and UI
  for a marginal case, and one-off overrides already exist as the per-task
  dropdown.
- **Positional safe fallback** — with the toggle OFF, resolve to the
  first-listed manifest mode. Rejected: reordering a manifest would silently
  change OFF behavior.
- **Parser rewrites `plan`** — under OFF, map `plan`→`build` for OpenCode.
  Rejected twice over: it makes the task *more* permissive, the opposite of
  what OFF means; and dropping `plan` from manifests entirely would break
  saved plans.
- **Remove `plan` mode as a product decision** — analysis can happen in the
  other modes. Rejected: it complicates the common case to simplify a rare
  one. The guide-steers-but-parser-respects settlement keeps it available
  without pushing anyone toward it.

## Consequences

- The toggle is generation-time only. Already stated above; worth repeating
  because it is the property users ask about.
- Manifest authors must tag at least one mode `autonomous` and one `safe`, or
  generation degrades to the pre-fix ad-hoc prompt. The builtin manifests
  (`claude-code`, `opencode`) tag both.
- OpenCode resolves to `build` whether the toggle is ON or OFF. The toggle is
  effectively a no-op for OpenCode-only plans. Correct, not a bug: there is
  nothing for it to switch between.
- `bypassPermissions`' manifest description no longer carries the "use only in
  sandboxed/CI environments" caveat. That caveat is what anchored the planner
  away from autonomous modes in the first place — a self-inflicted bug caused
  by our own copy. Manifest descriptions are prompt material, not core logic;
  editing them does not violate the no-hardcoded-modes rule.
- A future runner whose `plan` mode is not read-only must still be reachable
  by manual selection in the UI. The toggle steers the planner; it never
  overrides a human's explicit choice.

## Update 2026-10-01: two named levels

The toggle is unchanged in shape and still a boolean (`autonomousMode`,
`autonomousDefault`, TUI `autonomous`, VS Code `ordewell.autonomousMode`); what
changed is what users call its states and what the `safe` tag points at.

- **Full auto** is ON: each runner's `autonomous`-tagged mode. **Auto** is OFF:
  each runner's `safe`-tagged mode. `/auto full` and `/auto auto` select them
  (`ordewell auto full|auto` likewise); `on` and `off` stay as aliases, and a
  bare `/auto` in the TUI reports the current level instead of flipping it. The
  rule above is untouched — the level is read at plan generation, and a task's
  mode is never rewritten at spawn.
- **Claude Code.** `safe` moves from `default` to a new mode `auto` (`--permission-mode
  auto`), where Claude's own classifier approves or blocks each action. `default`
  ("Ask before edits") stays selectable but carries no level tag, so it is
  offered under both. `bypassPermissions` keeps `autonomous` and is relabelled
  "Bypass permissions": its old label, "Auto mode", collided with Claude's real
  auto mode. Claude Code 2.1.286 still accepts `--permission-mode default`
  although it no longer lists it, so no remapping to `manual` was needed.
- **Codex.** `agent` (`safe`) is the workspace-write sandbox with approval policy
  `on-request` and `approvals_reviewer=auto_review`, Codex's risk-assessing
  subagent; `fullAccess` (`autonomous`) stays `danger-full-access` with approvals
  `never`. The manifest expresses both per mode in `features.modeSettings`
  (`approvalPolicy`, `approvalsReviewer`). The interactive shape passes them as `-a` and
  `-c approvals_reviewer=…`; `exec` has no `-a`, so it takes the same values as
  `-c approval_policy=…` and `-c approvals_reviewer=…`.
- **OpenCode** is unchanged: `build` wears both tags, so the two levels resolve
  to the same mode there.
- **Consequence.** "Auto" is no longer the least-privileged choice on every
  runner: it trades a prompt for a reviewer's judgement. A person who wants every
  action to wait for them picks `default` (Claude) by hand, which no level selects.
