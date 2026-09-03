/**
 * The subset of Obsidian's `Menu` / `MenuItem` API that PixelPerfectImage's
 * menu-building helpers rely on. Both Obsidian's real `Menu` (used by the
 * standalone plugin path) and DragImageAutoArrange's DOM-backed menu (used when
 * the plugin is embedded) satisfy it, so the same builders can feed either.
 */

export interface MenuLikeItem {
    setTitle(title: string | DocumentFragment | HTMLElement): this;
    setIcon(icon: string): this;
    setDisabled(disabled: boolean): this;
    setWarning(warning: boolean): this;
    onClick(callback: () => void): this;
}

export interface MenuLike {
    addItem(callback: (item: MenuLikeItem) => unknown): this;
    addSeparator(): this;
}
