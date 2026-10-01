import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import { useFollowOutput } from '../followOutput';

// jsdom has no layout, so the log's geometry is faked: a 100px view onto `content` px.
interface Geometry { content: number; top: number }

function Log({ lines }: { lines: string[] }) {
  const ref = useFollowOutput<HTMLDivElement>(lines);
  return <div data-testid="log" ref={ref}>{lines.map((l) => <p key={l}>{l}</p>)}</div>;
}

function fake(el: HTMLElement, geometry: Geometry): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.content });
  Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => geometry.top, set: (v: number) => { geometry.top = v; } });
}

describe('following a live log', () => {
  let geometry: Geometry;
  let rerender: (lines: string[]) => void;
  let log: HTMLElement;

  beforeEach(() => {
    cleanup();
    geometry = { content: 100, top: 0 };
    const view = render(<Log lines={['one']} />);
    log = view.getByTestId('log');
    fake(log, geometry);
    rerender = (lines) => view.rerender(<Log lines={lines} />);
  });

  const readerScrollsTo = (top: number): void => {
    geometry.top = top;
    act(() => { fireEvent.scroll(log); });
  };

  it('keeps the newest output in view while the reader is at the bottom', () => {
    geometry.content = 600;
    rerender(['one', 'two']);
    expect(geometry.top).toBe(600);
  });

  it('stays put once the reader scrolls up to read back', () => {
    geometry.content = 600;
    readerScrollsTo(100);

    geometry.content = 900;
    rerender(['one', 'two']);
    expect(geometry.top).toBe(100);
  });

  it('follows again once the reader is back near the bottom', () => {
    geometry.content = 600;
    readerScrollsTo(100);
    readerScrollsTo(480);

    geometry.content = 900;
    rerender(['one', 'two']);
    expect(geometry.top).toBe(900);
  });
});
