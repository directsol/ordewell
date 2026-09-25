import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createTask, type ConversationMessage, type LegacyPlanState } from '../../models/Task';
import * as sessionStore from '../../utils/sessionStore';
import type { ConversationTurn, IAiService } from '../AiService';
import { ConversationBusyError, ConversationEditError } from '../PlannerConversation';
import { makeSession, type SessionOverrides } from './sessionTestKit';

const GOAL = 'build me a parser';

/** Two tasks — the second created by the turn a rewind to index 2 forks from before. */
function plannedDialogue(): LegacyPlanState {
  return {
    tasks: [
      createTask({ id: 't1', order: 1, title: 'Parse JSON', prompt: 'do it', assignedRunner: 'claude-code' }),
      createTask({ id: 't2', order: 2, title: 'Stream it', prompt: 'do it', assignedRunner: 'claude-code' }),
    ],
    generatedAt: '2026-01-01T00:00:00Z',
    status: 'approved',
    runners: ['claude-code'],
    lastUpdated: '2026-01-01T00:00:00Z',
    conversationHistory: [
      { role: 'user', content: GOAL, timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Plan generated with 1 task.', timestamp: '2026-01-01T00:00:01Z', kind: 'plan_generated' },
      { role: 'user', content: 'add streaming\nbut keep the reader pull-based', timestamp: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Tasks updated:\n- added #2', timestamp: '2026-01-01T00:00:03Z' },
    ],
    researchLog: [
      { id: 'up-1', type: 'user_prompt', content: GOAL, timestamp: '2026-01-01T00:00:00Z' },
      { id: 'up-2', type: 'user_prompt', content: 'add streaming', timestamp: '2026-01-01T00:00:02Z' },
    ],
  };
}

const reply = (text: string): ConversationTurn => ({ kind: 'message', text, researchLog: [] });

type PlannerFake = Pick<IAiService, 'startConversation' | 'continueConversation' | 'hasActiveConversation' | 'reset'>;

/**
 * A vendor API planner: its model context is a message list it rebuilds from
 * `priorHistory` when a conversation (re)starts.
 */
function apiStylePlanner() {
  const state: { context: string[] | null } = { context: null };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.context = [...(req.priorHistory ?? []).map((m: ConversationMessage) => m.content), req.initialMessage ?? req.goal];
      return reply('fresh');
    },
    continueConversation: async (message) => {
      state.context!.push(message);
      return reply('live');
    },
    hasActiveConversation: () => state.context !== null,
    reset: () => { state.context = null; },
  };
  return { planner, state };
}

/**
 * A harness planner (ADR-0009): a coding agent that resumes its own native
 * session when it still holds an id for one — which would bring the turns the
 * fork left out back no matter what transcript Ordewell replays.
 */
function harnessStylePlanner() {
  const state = { nativeSessionId: null as string | null, live: false, starts: [] as { resumedNative: string | null; replayed: string[] }[] };
  const planner: PlannerFake = {
    startConversation: async (req) => {
      state.starts.push({ resumedNative: state.nativeSessionId, replayed: (req.priorHistory ?? []).map((m) => m.content) });
      state.nativeSessionId = 'native-2';
      state.live = true;
      return reply('fresh');
    },
    continueConversation: async () => reply('live'),
    hasActiveConversation: () => state.live,
    reset: () => { state.live = false; state.nativeSessionId = null; },
  };
  return { planner, state };
}

describe('Session.rewindConversation', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ordewell-rewind-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const sessionsDir = () => path.join(workspace, '.ordewell', 'sessions');

  /** A session adopted from the real store, so both sides are read back the way a surface reads them. */
  function adoptedSession(overrides: SessionOverrides = {}) {
    const session = makeSession(overrides);
    vi.mocked(sessionStore.saveSession).mockRestore();
    sessionStore.saveSession(plannedDialogue(), GOAL, workspace, 'session-original');
    session.loadPlan(sessionStore.loadSession('session-original', workspace)!.plan, GOAL, workspace, { sessionId: 'session-original' });
    return session;
  }

  /** A second Session adopting the fork, as a host does. */
  function adoptFork(sessionId: string, overrides: SessionOverrides = {}) {
    const adopted = makeSession(overrides);
    adopted.loadPlan(sessionStore.loadSession(sessionId, workspace)!.plan, GOAL, workspace, { sessionId, persist: false });
    return adopted;
  }

  it('persists a fork holding the conversation up to just before the message, and the current tasks', () => {
    const session = adoptedSession();

    const fork = session.rewindConversation(2);

    expect(fork.sessionId).not.toBe('session-original');
    expect(fork.goal).toBe(GOAL);
    const saved = sessionStore.loadSession(fork.sessionId, workspace)!;
    expect(saved.meta.goal).toBe(GOAL);
    expect(saved.plan.conversationHistory).toEqual(plannedDialogue().conversationHistory!.slice(0, 2));
    expect(saved.plan.researchLog!.map((e) => e.id)).toEqual(['up-1']);
    expect(saved.plan.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(sessionStore.listSessions(workspace).map((m) => m.id).sort()).toEqual([fork.sessionId, 'session-original'].sort());
  });

  it('answers the full text of the message it rewound to', () => {
    const fork = adoptedSession().rewindConversation(2);

    expect(fork.rewoundMessage).toBe('add streaming\nbut keep the reader pull-based');
  });

  it('leaves the original session, its file byte for byte, and its live planner context untouched', () => {
    const reset = vi.fn();
    const session = adoptedSession({ aiService: { reset, hasActiveConversation: () => true } });
    reset.mockClear();
    const [file] = fs.readdirSync(sessionsDir());
    const bytes = fs.readFileSync(path.join(sessionsDir(), file));
    const history = structuredClone(session.planState!.conversationHistory);

    session.rewindConversation(2);

    expect(fs.readFileSync(path.join(sessionsDir(), file)).equals(bytes)).toBe(true);
    expect(session.sessionId).toBe('session-original');
    expect(session.planState!.conversationHistory).toEqual(history);
    expect(session.planTasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(reset).not.toHaveBeenCalled();
  });

  it('lists the rewind targets', () => {
    const session = adoptedSession();

    expect(session.rewindTargets()).toEqual([{ index: 2, preview: 'add streaming', content: 'add streaming\nbut keep the reader pull-based', timestamp: '2026-01-01T00:00:02Z' }]);
  });

  it('refuses an index that is not a rewind target, forking nothing', () => {
    const session = adoptedSession();

    expect(() => session.rewindConversation(1)).toThrow(ConversationEditError);
    expect(sessionStore.listSessions(workspace)).toHaveLength(1);
  });

  it('refuses while a planner turn is in flight', async () => {
    let finish: (turn: ConversationTurn) => void = () => {};
    const session = adoptedSession({
      aiService: {
        hasActiveConversation: () => true,
        continueConversation: vi.fn(() => new Promise<ConversationTurn>((resolve) => { finish = resolve; })),
      },
    });

    const turn = session.continueConversation('and CSV');
    expect(() => session.rewindConversation(2)).toThrow(ConversationBusyError);

    finish(reply('Noted'));
    await turn;
    expect(() => session.rewindConversation(2)).not.toThrow();
  });

  it('refuses with no conversation to rewind', () => {
    expect(() => makeSession().rewindConversation(2)).toThrow(ConversationEditError);
  });

  it('replays the fork\'s transcript on its first message for a vendor API planner', async () => {
    const fork = adoptedSession().rewindConversation(2);
    const { planner, state } = apiStylePlanner();
    const adopted = adoptFork(fork.sessionId, { aiService: planner });

    await adopted.continueConversation('add CSV instead');

    expect(state.context!.slice(0, 2)).toEqual([GOAL, 'Plan generated with 1 task.']);
    expect(state.context).toHaveLength(3);
    expect(state.context![2].endsWith('add CSV instead')).toBe(true);
  });

  it('replays the fork\'s transcript for a harness planner without resuming the original\'s native session', async () => {
    const original = harnessStylePlanner();
    const session = adoptedSession({ aiService: original.planner });
    Object.assign(original.state, { nativeSessionId: 'native-1', live: true });
    const fork = session.rewindConversation(2);
    const { planner, state } = harnessStylePlanner();
    const adopted = adoptFork(fork.sessionId, { aiService: planner });

    await adopted.continueConversation('add CSV instead');

    expect(state.starts).toEqual([{ resumedNative: null, replayed: [GOAL, 'Plan generated with 1 task.'] }]);
    expect(original.state).toMatchObject({ nativeSessionId: 'native-1', live: true });
  });
});
