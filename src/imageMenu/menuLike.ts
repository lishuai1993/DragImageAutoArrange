/**
 * Minimal menu surface the row builders write through, so they never depend on
 * Obsidian's own `Menu` API (which cannot nest) nor on the concrete DOM
 * implementation in `menuUi.ts`.
 */

export interface MenuLikeItem {
    setTitle(title: string | DocumentFragment | HTMLElement): this;
    setIcon(icon: string): this;
    setDisabled(disabled: boolean): this;
    setWarning(warning: boolean): this;
    onClick(callback: () => void): this;
}

export interface MenuLike {
    addSeparator(): this;
    addItem(callback: (item: MenuLikeItem) => unknown): this;
}
