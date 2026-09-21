/**
 * The display language: how a pair resolves, how a table follows it, and a guard
 * over every string the plugin can put in front of the user.
 *
 * The guard is the point of the file. Copy is stored as `{ zh, en }` next to the
 * code that shows it, which means a missing or half-done translation is not a
 * key lookup failure but a string that simply reads wrong in one language. So
 * instead of checking a handful of labels, this walks every pair the plugin
 * declares — the settings row table, the menu tables, the notices, and the two
 * sections that bring their own rows — and asserts that the Chinese rendering
 * contains Chinese and the English rendering contains none. A string added in
 * one language only, or a Chinese sentence left in the English table, fails here.
 *
 * The sections that own their rows are walked through their definitions rather
 * than through their module-private tables: `definitions()` resolves the copy the
 * same way the rendered tab does, so the walk sees exactly what a user would.
 */
import { describe, it, expect } from 'vitest';
import type { App, SettingDefinitionItem } from 'obsidian';
import { setLanguage, t, type Language, type Localized } from '../src/i18n/language';
import { SETTINGS_SECTIONS, type RowSpec } from '../src/settingsSpecs';
import {
  FILE_OPERATION_LABELS,
  MENU_TEXT,
  NOTICE_DONE,
  NOTICE_FAILED,
  contextMenuDisabledLines,
} from '../src/imageMenu/menuLabels';
import {
  CUT_TEXT,
  DELETE_TEXT,
  cutImageKeptNotice,
  deleteImageKeptNotice,
} from '../src/imageMenu/cutImage';
import {
  imageMenuSectionDefinitions,
  type ImageMenuBridge,
} from '../src/imageMenu/menuSettingsUi';
import { DEFAULT_IMAGE_MENU_SETTINGS } from '../src/imageMenu/settingsModel';
import {
  createMaintenanceSection,
  type MaintenanceBridge,
} from '../src/maintenance/maintenanceSettingsUi';

/**
 * Han characters plus CJK punctuation (「」（）…). A short Chinese label may carry
 * no Han character at all, but it always carries one or the other; the English
 * copy uses ’ “ ” — → … , which fall outside every one of these ranges, so a
 * stray Chinese character is what this catches.
 *
 * The range opens at U+3001 (、), one past the ideographic space U+3000: no
 * string the plugin declares contains that space, and writing it into the class
 * would put an irregular whitespace character in this file.
 */
const CJK = /[、-〿一-鿿＀-￯]/;

/**
 * Pairs that are deliberately the same in both languages, because the string is
 * a proper noun with nothing to translate. Spelled out rather than tolerated by
 * a rule ("zh may equal en"): a rule would silently excuse the very fault this
 * guard exists for — English left in the Chinese column.
 */
const SAME_IN_BOTH = new Set<string>(['MENU_TEXT.obsidianUrl']);

/** A named string, read afresh on every call so it follows the language. */
type Entry = readonly [label: string, read: () => string];

function tableEntries<T extends object>(table: T, prefix: string): Entry[] {
  return (Object.keys(table) as Array<keyof T & string>).map((key) => [
    `${prefix}.${key}`,
    () => String((table as Record<string, unknown>)[key]),
  ]);
}

/** One pair, both sides asserted. */
function expectPair(label: string, pair: Localized): void {
  expect(pair.zh, `${label} has no Chinese`).not.toBe('');
  expect(pair.en, `${label} has no English`).not.toBe('');
  if (!SAME_IN_BOTH.has(label)) {
    expect(pair.zh, `${label} (zh) has no Chinese`).toMatch(CJK);
  }
  expect(pair.en, `${label} (en) still contains Chinese`).not.toMatch(CJK);
}

/** Assert one language over strings that resolve through the singleton. */
function expectLanguage(entries: readonly Entry[], lang: Language): void {
  setLanguage(lang);
  for (const [label, read] of entries) {
    const text = read();
    expect(text, `${label} (${lang}) is empty`).not.toBe('');
    if (lang === 'zh') {
      if (!SAME_IN_BOTH.has(label)) {
        expect(text, `${label} (zh) has no Chinese`).toMatch(CJK);
      }
    } else {
      expect(text, `${label} (en) still contains Chinese`).not.toMatch(CJK);
    }
  }
}

// ── The pair itself ─────────────────────────────────────────────────────

describe('a text pair', () => {
  const greeting: Localized = { zh: '你好，{name}', en: 'Hello, {name}' };

  it('resolves against the language in force when it is read', () => {
    setLanguage('zh');
    expect(t(greeting, { name: 'DIAA' })).toBe('你好，DIAA');
    setLanguage('en');
    expect(t(greeting, { name: 'DIAA' })).toBe('Hello, DIAA');
  });

  it('leaves a placeholder with no matching var as written', () => {
    setLanguage('en');
    expect(t(greeting)).toBe('Hello, {name}');
    expect(t(greeting, { other: 1 })).toBe('Hello, {name}');
  });
});

// ── The tables that follow it ───────────────────────────────────────────

describe('a localised table', () => {
  it('resolves each entry on read, not when the table was built', () => {
    // Built once at import — the whole point of the getter-backed table is that
    // reading it later still follows the language.
    setLanguage('en');
    expect(MENU_TEXT.copyImage).toBe('Copy image');
    setLanguage('zh');
    expect(MENU_TEXT.copyImage).toBe('复制图像');
  });
});

// ── Guard: every declared pair ──────────────────────────────────────────

describe('every string the plugin shows', () => {
  it('starts in English, so a fresh install matches the plugin’s audience', () => {
    setLanguage('en');
    expect(t({ zh: '中文', en: 'English' })).toBe('English');
  });

  it('carries both languages in the settings row table', () => {
    let seen = 0;
    const pair = (label: string, text: Localized) => {
      seen += 1;
      expectPair(label, text);
    };
    const row = (label: string, spec: RowSpec) => {
      pair(`${label}.name`, spec.name);
      pair(`${label}.desc`, spec.desc);
      if (spec.kind === 'dropdown') {
        for (const [value, optionLabel] of spec.options) pair(`${label}.${value}`, optionLabel);
      }
    };

    for (const section of SETTINGS_SECTIONS) {
      if (section.kind !== 'group') continue;
      pair(`${section.heading.en} heading`, section.heading);
      for (const spec of section.rows) row(`${section.heading.en} › ${spec.name.en}`, spec);
    }

    // A table that yielded nothing would pass every assertion above.
    expect(seen).toBeGreaterThan(20);
  });

  it('carries both languages in the menu tables and the notices', () => {
    const entries: Entry[] = [
      ...tableEntries(MENU_TEXT, 'MENU_TEXT'),
      ...tableEntries(NOTICE_DONE, 'NOTICE_DONE'),
      ...tableEntries(NOTICE_FAILED, 'NOTICE_FAILED'),
      ...tableEntries(FILE_OPERATION_LABELS, 'FILE_OPERATION_LABELS'),
      ...tableEntries(CUT_TEXT, 'CUT_TEXT'),
      ...tableEntries(DELETE_TEXT, 'DELETE_TEXT'),
      ['cutImageKeptNotice', () => cutImageKeptNotice(3)],
      ['deleteImageKeptNotice', () => deleteImageKeptNotice(3)],
      ['contextMenuDisabledLines(copied)', () => contextMenuDisabledLines('Cmd', true).join(' ')],
      ['contextMenuDisabledLines(refused)', () => contextMenuDisabledLines('Cmd', false).join(' ')],
    ];

    expectLanguage(entries, 'zh');
    expectLanguage(entries, 'en');
  });

  it('carries both languages in the sections that bring their own rows', () => {
    const menuBridge: ImageMenuBridge = {
      getSettings: () => DEFAULT_IMAGE_MENU_SETTINGS,
      saveSettings: async () => {},
    };
    const maintenanceBridge: MaintenanceBridge = {
      extensions: 'png',
      alignment: 'left',
      maxImagesPerRow: 4,
    };
    const section = createMaintenanceSection({} as unknown as App, () => maintenanceBridge);

    /** The copy a definitions consumer sees: each group's heading and each row's
     *  name and description, in document order. */
    const flatten = (items: SettingDefinitionItem[]): string[] => {
      const out: string[] = [];
      for (const item of items) {
        if ('type' in item && item.type === 'group') {
          if (item.heading) out.push(item.heading);
          for (const child of item.items ?? []) {
            const copy = child as { name?: string; desc?: string };
            if (copy.name) out.push(copy.name);
            if (copy.desc) out.push(copy.desc);
          }
        }
      }
      return out;
    };

    const sources: Array<readonly [string, () => string[]]> = [
      [
        'imageMenuSectionDefinitions',
        () => flatten(imageMenuSectionDefinitions(menuBridge, () => {})),
      ],
      ['maintenance definitions', () => flatten(section.definitions())],
    ];

    for (const [label, produce] of sources) {
      setLanguage('zh');
      const zh = produce();
      setLanguage('en');
      const en = produce();

      expect(zh.length, `${label} produced no copy`).toBeGreaterThan(0);
      expect(en.length, `${label} lost copy in English`).toBe(zh.length);
      zh.forEach((text, i) => {
        expect(text, `${label}[${i}] (zh) has no Chinese`).toMatch(CJK);
      });
      en.forEach((text, i) => {
        expect(text, `${label}[${i}] (en) still contains Chinese`).not.toMatch(CJK);
      });
    }
  });
});
