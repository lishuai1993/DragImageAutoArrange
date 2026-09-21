/**
 * Display language for everything the plugin draws for the user: the settings
 * tab and the image right-click menu.
 *
 * The text itself is not kept here. It lives where it is shown, as a
 * `{ zh, en }` pair, and is resolved when it is *read* rather than when its
 * module is imported. Two shapes of reader exist and both follow that rule:
 *
 *  - a table read while rendering — the settings row table — resolves each pair
 *    through `t()` at the point of use;
 *  - a table read inside a function that runs on a user action — the menu
 *    labels — goes through `localize()`, which turns the pairs into an object
 *    whose properties resolve on read. `MENU_TEXT.transform` therefore stays a
 *    plain string expression and its call sites need no change at all.
 *
 * The one thing that defeats both is a module-level value built *from* a pair at
 * import time — it captures the language in force at import and never updates.
 * Such a value has to move into the function that uses it.
 */

export type Language = "zh" | "en";

/** The same sentence in both languages, written side by side at the point of
 *  use so neither can be added without the other. */
export type Localized = { readonly zh: string; readonly en: string };

/** Matches the shipped default — see DEFAULT_SETTINGS.language. */
let current: Language = "en";

export function setLanguage(next: Language): void {
  current = next;
}

/**
 * The text for the current language, with `{name}` placeholders filled from
 * `vars`. A placeholder with no matching var is left as written, so a typo
 * shows up in the UI as itself rather than as `undefined`.
 */
export function t(text: Localized, vars?: Record<string, string | number>): string {
  const raw = text[current];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match
  );
}

/** A table of pairs as an object of plain strings, resolved on every read. */
export function localize<T extends Record<string, Localized>>(
  pairs: T
): { [K in keyof T]: string } {
  const out = {} as { [K in keyof T]: string };
  for (const key of Object.keys(pairs) as Array<keyof T>) {
    Object.defineProperty(out, key, {
      enumerable: true,
      get: () => t(pairs[key]),
    });
  }
  return out;
}
