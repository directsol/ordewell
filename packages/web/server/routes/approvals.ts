import { Hono } from 'hono';
import { isGranted, toApprovalDecision, type ApprovalAnswer } from '@ordewell/core';
import type { OrchestratorPool } from '../pool/orchestratorPool';

/**
 * A body's answer. `{ decision, note? }` carries a runner request's whole
 * answer (ADR-0018, A1); `{ granted }` is the planner prompt's yes/no.
 * Anything else — absent, malformed, an unknown decision — is a denial,
 * never consent.
 */
function answerOf(body: unknown): ApprovalAnswer {
  if (typeof body !== 'object' || body === null) return false;
  const { decision, note, granted } = body as { decision?: unknown; note?: unknown; granted?: unknown };
  if (decision === undefined) return granted === true;
  if (decision === 'allow' || decision === 'allowForTask') return { decision };
  if (decision === 'deny' && typeof note === 'string' && note.trim()) return { decision, note: note.trim() };
  return { decision: 'deny' };
}

/**
 * The answer channel for approval prompts — the planner's, and a task
 * runner's tool requests.
 *
 * Requests go out over the session WebSocket (they are ordinary
 * SessionMessages), but answers come back here rather than over the socket:
 * the CLI and TUI already speak HTTP to this server, a prompt can outlive the
 * socket that announced it, and a plain POST is answerable from any surface —
 * including `curl` in a pinch.
 */
export function approvalsRoute(pool: OrchestratorPool) {
  const router = new Hono();

  router.get('/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId');
    if (!pool.hasSession(sessionId)) return c.json({ error: `Unknown session: ${sessionId}` }, 404);

    return c.json({
      pending: pool.outstandingApprovals(sessionId),
      approvedScopes: pool.approvedScopes(sessionId),
    });
  });

  router.post('/:sessionId/:approvalId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const approvalId = c.req.param('approvalId');
    if (!pool.hasSession(sessionId)) return c.json({ error: `Unknown session: ${sessionId}` }, 404);

    const answer = answerOf(await c.req.json().catch(() => null));

    if (!pool.resolveApproval(sessionId, approvalId, answer)) {
      return c.json({ error: 'Approval is no longer outstanding — it timed out or was already answered.' }, 409);
    }
    const { decision } = toApprovalDecision(answer);
    return c.json({ ok: true, granted: isGranted({ decision }), decision });
  });

  return router;
}
