/**
 * The one style every clickable control in the settings tab wears.
 *
 * The accent-filled treatment (with its hover, focus and disabled states) comes
 * from Obsidian's own CTA style; `SETTING_BUTTON_CLASS` adds the transition and
 * the pressed-flash hook on top — see the `.drag-img-setting-btn` rules in
 * styles.css. Keeping both in one place means a newly added button can't drift
 * into looking less available than its neighbours.
 */

import type { ButtonComponent } from 'obsidian';

export const SETTING_BUTTON_CLASS = 'drag-img-setting-btn';

/** Style `button` and hand it back, so this reads inline in an `addButton` chain. */
export function applySettingButtonStyle(button: ButtonComponent): ButtonComponent {
  button.buttonEl.addClass(SETTING_BUTTON_CLASS);
  return button.setCta();
}
