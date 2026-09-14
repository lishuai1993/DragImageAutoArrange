/**
 * @vitest-environment jsdom
 *
 * Tests for the scroll-jump probe (temporary instrumentation).
 *
 * The probe is only useful if it (a) stays silent until a rotation opens its
 * window, and (b) actually attaches and detaches the scroll listener. If it
 * failed silently the diagnosis run would come back empty and be misread as
 * "no evidence".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { logger } from '../src/logger';
import * as scrollDiag from '../src/scrollSync/scrollDiag';

/** Minimal EditorView surface the probe reads. */
function fakeView(): { view: EditorView; dom: HTMLElement; listeners: { add: number; remove: number } } {
  const dom = document.createDiv();
  const listeners = { add: 0, remove: 0 };
  const origAdd = dom.addEventListener.bind(dom);
  const origRemove = dom.removeEventListener.bind(dom);
  dom.addEventListener = ((
    ...args: Parameters<typeof origAdd>
  ) => {
    listeners.add++;
    return origAdd(...args);
  }) as typeof dom.addEventListener;
  dom.removeEventListener = ((
    ...args: Parameters<typeof origRemove>
  ) => {
    listeners.remove++;
    return origRemove(...args);
  }) as typeof dom.removeEventListener;

  const doc = {
    lines: 3,
    length: 30,
    line: (n: number) => ({ from: (n - 1) * 10, text: `line ${n}` }),
  };
  const view = {
    scrollDOM: dom,
    defaultLineHeight: 20,
    state: { doc },
    lineBlockAt: () => ({ top: 100, height: 200, from: 10, widget: { estimatedHeight: -1 } }),
    lineBlockAtHeight: () => ({ top: 0, from: 0 }),
  } as unknown as EditorView;
  return { view, dom, listeners };
}

describe('scrollDiag probe', () => {
  const info = vi.spyOn(logger.channel('scrollDiag'), 'info').mockImplementation(() => {});

  beforeEach(() => {
    info.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    scrollDiag.closeRotationWindow();
    vi.useRealTimers();
  });

  it('is a no-op before any window opens', () => {
    scrollDiag.note('outside window');
    expect(info).not.toHaveBeenCalled();
    expect(scrollDiag.isActive()).toBe(false);
  });

  it('reports a missing EditorView instead of failing silently', () => {
    scrollDiag.openRotationWindow(null, 4, '![[a.png]]');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0][0]).toContain('open skipped');
  });

  it('opens a window, records notes, and releases the scroll listener', () => {
    const { view, listeners } = fakeView();
    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    expect(scrollDiag.isActive()).toBe(true);
    expect(listeners.add).toBe(1);
    expect(info.mock.calls[0][0]).toContain('[ROT 000] open');

    scrollDiag.note('eq=false');
    const tags = info.mock.calls.map((c) => c[0]);
    expect(tags.some((t) => t.includes('eq=false'))).toBe(true);

    scrollDiag.closeRotationWindow();
    expect(scrollDiag.isActive()).toBe(false);
    expect(listeners.remove).toBe(1);
    scrollDiag.note('after close');
    expect(info.mock.calls.map((c) => c[0]).some((t) => t.includes('after close'))).toBe(false);
  });

  it('auto-closes after the window elapses', () => {
    const { view } = fakeView();
    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    expect(scrollDiag.isActive()).toBe(true);
    vi.advanceTimersByTime(1500);
    expect(scrollDiag.isActive()).toBe(false);
  });

  it('tolerates a repeated close', () => {
    const { view } = fakeView();
    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    scrollDiag.closeRotationWindow();
    expect(() => scrollDiag.closeRotationWindow()).not.toThrow();
  });

  it('never reads layout from note(), and cannot leak a throwing measure', () => {
    // The real trap: toDOM/updateDOM/destroy run inside CodeMirror's update
    // cycle, where lineBlockAt()/lineBlockAtHeight() throw
    // "Reading the editor layout isn't allowed during an update". destroy() has
    // no try/catch, so a throw there used to abort the update and leave the
    // editor unrendered.
    const calls = { lineBlockAt: 0, lineBlockAtHeight: 0 };
    const dom = document.createDiv();
    const view = {
      scrollDOM: dom,
      defaultLineHeight: 20,
      state: { doc: { lines: 3, length: 30, line: (n: number) => ({ from: (n - 1) * 10, text: `l${n}` }) } },
      lineBlockAt: () => {
        calls.lineBlockAt++;
        throw new Error("Reading the editor layout isn't allowed during an update");
      },
      lineBlockAtHeight: () => {
        calls.lineBlockAtHeight++;
        throw new Error("Reading the editor layout isn't allowed during an update");
      },
    } as unknown as EditorView;

    expect(() => scrollDiag.openRotationWindow(view, 1, '![[a.png]]')).not.toThrow();
    // open()'s own measurement is contained and reported instead of thrown.
    const openData = info.mock.calls[0][1] as Record<string, unknown>;
    expect(String(openData.block)).toContain('err:');

    calls.lineBlockAt = 0;
    calls.lineBlockAtHeight = 0;
    expect(() => scrollDiag.note('inside an update cycle')).not.toThrow();
    expect(calls.lineBlockAt).toBe(0);
    expect(calls.lineBlockAtHeight).toBe(0);
    const noteData = info.mock.calls[1][1] as Record<string, unknown>;
    expect(noteData.scrollTop).toBe(0);
    expect(noteData.lineH).toBe(20);
    expect(noteData.docLines).toBe(3);
  });

  it('names the writer of scrollTop, and releases the spy when the window closes', () => {
    const { view, dom } = fakeView();
    expect(Object.getOwnPropertyDescriptor(dom, 'scrollTop')).toBeUndefined();

    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    expect(Object.getOwnPropertyDescriptor(dom, 'scrollTop')).toBeTruthy();

    dom.scrollTop = 2598;
    const write = info.mock.calls.find((c) => String(c[0]).includes('scrollTop SET'));
    expect(write).toBeTruthy();
    const data = write?.[1] as Record<string, unknown>;
    expect(data.via).toBe('scrollTop =');
    expect(data.from).toBe(0);
    expect(data.to).toBe(2598);
    expect(String(data.stack)).toContain('scrollDiag.test');

    scrollDiag.closeRotationWindow();
    expect(Object.getOwnPropertyDescriptor(dom, 'scrollTop')).toBeUndefined();
    dom.scrollTop = 7;
    const later = info.mock.calls
      .filter((c) => String(c[0]).includes('scrollTop SET'))
      .map((c) => (c[1] as Record<string, unknown>).to);
    expect(later).toEqual([2598]);
    expect(dom.scrollTop).toBe(7); // 摘罩后仍是真实的元素
  });

  it('also catches scrollTo / scrollIntoView, which bypass the scrollTop setter', () => {
    const { view, dom } = fakeView();
    const host = dom as unknown as Record<string, unknown>;
    const seen: string[] = [];
    host.scrollTo = (...args: unknown[]): void => {
      seen.push('scrollTo');
      void args;
    };
    host.scrollIntoView = (...args: unknown[]): void => {
      seen.push('scrollIntoView');
      void args;
    };

    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    (host.scrollTo as (o: { top?: number }) => void)({ top: 2598 });
    (host.scrollIntoView as (o: { block?: string }) => void)({ block: 'center' });

    const writes = info.mock.calls
      .filter((c) => String(c[0]).includes('scrollTop SET'))
      .map((c) => c[1] as Record<string, unknown>);
    expect(writes.map((w) => w.via)).toEqual(['scrollTo', 'scrollIntoView']);
    expect(writes[0].to).toBe(2598); // 对象形式的目标位置被解出
    expect(seen).toEqual(['scrollTo', 'scrollIntoView']); // 且原样转发
  });

  it('never lets a logging failure swallow or escape a write', () => {
    const { view, dom } = fakeView();
    scrollDiag.openRotationWindow(view, 1, '![[a.png]]');
    info.mockImplementation(() => {
      throw new Error('log sink exploded');
    });
    expect(() => {
      dom.scrollTop = 1234;
    }).not.toThrow();
    expect(dom.scrollTop).toBe(1234); // 记录失败也必须放行
    info.mockImplementation(() => {});
    scrollDiag.closeRotationWindow();
  });
});
