/**
 * The one style every clickable control in the settings tab wears.
 *
 * The accent-filled treatment (with its hover, focus and disabled states) comes
 * from Obsidian's own CTA style; `SETTING_BUTTON_CLASS` adds the transition and
 * the pressed-flash hook on top — see the `.diaa-setting-btn` rules in
 * styles.css. Keeping both in one place means a newly added button can't drift
 * into looking less available than its neighbours.
 *
 * The one control that bypasses this is the language row's segmented bar
 * (`.diaa-segmented` in styles.css, built in `buildLanguageRow`). It is one
 * control, not a row of buttons: both halves sit on a shared grey track with no
 * borders anywhere, and the selection is a solid fill inside that track. That
 * reads as a single object only while the halves keep the same shape and the
 * same two colours — which a pair of separately framed CTA buttons cannot.
 */

import type { ButtonComponent } from 'obsidian';

export const SETTING_BUTTON_CLASS = 'diaa-setting-btn';

/** Style `button` and hand it back, so this reads inline in an `addButton` chain. */
export function applySettingButtonStyle(button: ButtonComponent): ButtonComponent {
  button.buttonEl.addClass(SETTING_BUTTON_CLASS);
  return button.setCta();
}
