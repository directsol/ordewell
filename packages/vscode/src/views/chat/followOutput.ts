import { useCallback, useLayoutEffect, useRef } from 'react';

/** How far above the bottom still counts as reading the newest output. */
const PIN_SLACK_PX = 50;

/**
 * Keeps a live log on its newest output while the reader is at the bottom,
 * and leaves it where it is once they scroll up to read back. Every log in the
 * webviews that grows under the reader follows through this one hook.
 *
 * Returns the ref for the element that scrolls. `content` is what, on change,
 * may have added output. A newly attached element starts at its bottom.
 */
export function useFollowOutput<T extends HTMLElement>(...content: unknown[]): (el: T | null) => void {
  const elRef = useRef<T | null>(null);
  const pinnedRef = useRef(true);
  const detachRef = useRef<(() => void) | null>(null);

  // Instant, never smooth: a smooth scroll fires scroll events mid-animation
  // that read as "scrolled away" when a large block lands, which unpins it.
  const stick = useCallback(() => {
    const el = elRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, []);

  const attach = useCallback((el: T | null) => {
    detachRef.current?.();
    detachRef.current = null;
    elRef.current = el;
    if (!el) return;

    pinnedRef.current = true;
    const onScroll = (): void => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_SLACK_PX;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // What shares the view with the log (a composer, a dock, a banner) takes
    // height from it without a scroll event, pushing the newest lines out.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
    observer?.observe(el);
    detachRef.current = () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
    stick();
  }, [stick]);

  useLayoutEffect(stick, content);

  return attach;
}
