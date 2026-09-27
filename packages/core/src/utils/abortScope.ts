/**
 * A stop of the service's own for one planner call, which `reset()` aborts
 * directly and the caller's signal aborts too. The caller's listener is bound
 * to this scope, not to whatever call is running when it fires: a caller that
 * aborts the signal it gave a call already over must not stop the next one.
 */
export function abortScope(callerSignal?: AbortSignal): AbortController {
  const scope = new AbortController();
  if (callerSignal?.aborted) scope.abort();
  else callerSignal?.addEventListener('abort', () => scope.abort(), { once: true });
  return scope;
}
