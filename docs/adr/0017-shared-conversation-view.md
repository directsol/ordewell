# 0017 — The shared conversation view, drawn once in core

**Status:** accepted

The planner conversation existed for a long time (ADR-0002), but what a surface
showed of it was each surface's own business. The TUI and the VS Code webview
each accumulated their own presentation state out of the `SessionMessage`
stream — and that accumulation diverged: one surface rendered a research step
the other dropped, a retransmit on reconnect showed blocks one surface had
already settled, and every new message type had to be taught to both
renderers. Replies were opaque to boot: before #48, a harness planner's
prose arrived only when the turn settled, and before #49 nothing on screen said
what a session had consumed, even where the runner reported it honestly.

## Decision

**Build the view once in core and draw it per surface.** Core owns
`reduceConversation` (ADR terms: the [conversation view](../../CONTEXT.md)) which
folds every `SessionMessage` — plus a surface's own local entries — into an
ordered list of **display blocks** (`core/src/conversation/blocks.ts`):
messages, thinking, tool rows, subagent blocks with their children, approvals,
plan markers, and the one usage line. A surface adapts the block list to its
own presentation; it never re-derives the conversation from raw messages.

- **Turns, segments, retractions (E1).** A planner turn
  (`planner_turn_started` … `planner_turn_ended` under one `turnId`) is the
  unit of streaming. Reply text arrives as `segmentId`-keyed segments whose
  accumulated text a settled `planner_message` replaces; a turn can retract
  streamed text (`planner_text_retracted`) without ending. The stream stays
  provisional and the settled messages authoritative.
- **`planner_message` stays authoritative (A1).** When a turn settles, the
  message replaces its final segment's streamed text. Streamed text is never
  written to the transcript, so a reloaded session cannot resurrect text the
  turn's classification overruled.
- **JSON envelopes stream as `plan_token` (J1).** A reply that is a plan or
  task-ops envelope never decays into visible prose; it is the "building plan"
  display, and becomes a plan marker block when it settles.
- **Usage only from reports (U1).** Usage records carry only what a provider or
  runner itself reported — tokens, cached tokens, a stated context window,
  a stated cost. No price table, no estimate: prices go stale, and a
  subscription runner has no per-token price at all. Absent means "not
  reported", never zero. The token line is one `usage` block, always last; the
  context fill is derived only for the planner's own calls, and omitted when
  either half is unknown.
- **The saved subset for reload (R1).** `fromTranscript` rebuilds the view a
  session reopens with from its persisted transcript and research log: settled
  messages, tool rows, subagent blocks and digests, and the token line. It
  deliberately leaves out thinking and everything that was only ever streamed —
  no `transcriptAt` beyond what the transcript itself records, and no reliance
  on the in-flight view. What reload shows is what was saved, not what was seen.
- **Expansion is one toggle per surface (X1).** Collapsed is the default: a
  command row reads `Name(keyArg)`, a subagent is one line, and one detail flag
  (the TUI's ctrl+o, VS Code's header button) shows arguments, full output,
  subagent children and digests. The flag is surface state, keyed on block
  ids that stay stable for as long as the block exists — never stored in core.

## Rejected

- **Per-surface views, one per client.** That was the status quo: two
  accumulators drifting, and every new message type rendered differently in
  each. The view is also what lets a reloaded session and a live one draw the
  same way — two implementations would have to re-prove *that* separately.
- **A price table for cost estimates.** A model id does not fix what it costs
  (routing, caching and subscriptions all change it), so any table's answer
  would be fiction presented as a number. Cost shows only where a source
  reported its own.
- **Persisting the full event log** so reload could replay it. It would save
  every streamed semi-state (deltas, retractions, thinking) at persist time
  forever, and freeze the message stream into an interface a transcript format
  change could never shed. The transcript is the record; the view over it is
  derived.
- **A component-tree TUI** (see [ADR-0006](0006-tui-pure-core-thin-driver.md)).
  Rejected there per D1; the conversational view strengthens the point — a
  block list is renderable as strings, and that is all the renderer has ever
  needed from a state.
- **Per-block focus and expansion** — one expanded flag per block, navigated
  with keys, remembered per block. It is more keys and more state than the use
  case needs: what a user wants is *all* the detail or *none*, and the user
  chose a single toggle, as in Claude Code. A per-block flag would also have to
  live in surface state keyed on block ids, growing with the conversation, for
  a distinction nobody asked for.
