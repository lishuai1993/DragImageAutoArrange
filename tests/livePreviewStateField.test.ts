import { describe, it, expect, vi } from 'vitest';

// Only mock obsidian and @codemirror/view — use the real @codemirror/state
// so StateEffect.define and StateField.define produce real objects.
vi.mock('obsidian', () => ({
  editorLivePreviewField: {},
}));

vi.mock('@codemirror/view', () => ({
  Decoration: { replace: () => ({}), none: {} },
  DecorationSet: {},
  EditorView: {},
  ViewPlugin: { fromClass: () => ({}) },
  WidgetType: class {},
  ViewUpdate: class {},
}));

import { EditorState } from '@codemirror/state';
import {
  layoutVersionField,
  forceLayoutRefresh,
} from '../src/imageRender/livePreview';

describe('layoutVersionField', () => {
  it('create returns 0', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
    });
    expect(state.field(layoutVersionField)).toBe(0);
  });

  it('forceLayoutRefresh effect updates the field value', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
    });
    const newState = state.update({
      effects: forceLayoutRefresh.of(5),
    }).state;
    expect(newState.field(layoutVersionField)).toBe(5);
  });

  it('dispatch without effect keeps field unchanged', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
    });
    const newState = state.update({}).state;
    expect(newState.field(layoutVersionField)).toBe(0);
  });

  it('increments correctly across multiple dispatches', () => {
    let state = EditorState.create({
      extensions: [layoutVersionField],
    });
    state = state.update({
      effects: forceLayoutRefresh.of(1),
    }).state;
    state = state.update({
      effects: forceLayoutRefresh.of(2),
    }).state;
    state = state.update({
      effects: forceLayoutRefresh.of(3),
    }).state;
    expect(state.field(layoutVersionField)).toBe(3);
  });

  it('field is preserved when other changes happen in same transaction', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
      doc: 'hello world',
    });
    const newState = state.update({
      changes: { from: 0, to: 5, insert: 'goodbye' },
      effects: forceLayoutRefresh.of(42),
    }).state;
    expect(newState.doc.toString()).toBe('goodbye world');
    expect(newState.field(layoutVersionField)).toBe(42);
  });

  it('field does not change when doc changes without the effect', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
      doc: 'hello',
    });
    const newState = state.update({
      changes: { from: 0, insert: '!' },
    }).state;
    expect(newState.field(layoutVersionField)).toBe(0);
  });
});

describe('forceLayoutRefresh', () => {
  it('of() creates an effect that updates layoutVersionField', () => {
    const state = EditorState.create({
      extensions: [layoutVersionField],
    });
    const newState = state.update({
      effects: forceLayoutRefresh.of(99),
    }).state;
    expect(newState.field(layoutVersionField)).toBe(99);
  });

  it('different effect types do not interfere with layoutVersionField', async () => {
    const { StateEffect } = await vi.importActual<typeof import('@codemirror/state')>('@codemirror/state');
    const otherEffect = StateEffect.define<number>();
    const state = EditorState.create({
      extensions: [layoutVersionField],
    });
    // Dispatch only the other effect — field should stay at 0
    const newState = state.update({
      effects: otherEffect.of(42),
    }).state;
    expect(newState.field(layoutVersionField)).toBe(0);
  });

  it('forceLayoutRefresh effect does not match other effect types (isolation)', async () => {
    // Verify isolation: forceLayoutRefresh.of() only affects layoutVersionField,
    // not some other field that watches a different effect
    const { StateEffect, StateField } = await vi.importActual<typeof import('@codemirror/state')>('@codemirror/state');
    const otherEffect = StateEffect.define<number>();
    const otherField = StateField.define<number>({
      create() { return -1; },
      update(value, tr) {
        for (const e of tr.effects) {
          if (e.is(otherEffect)) return e.value;
        }
        return value;
      },
    });
    const state = EditorState.create({
      extensions: [otherField],
    });
    // Dispatch forceLayoutRefresh — otherField should stay at -1
    const newState = state.update({
      effects: forceLayoutRefresh.of(7),
    }).state;
    expect(newState.field(otherField)).toBe(-1);
  });
});
