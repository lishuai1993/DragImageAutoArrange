/**
 * 菜单构建器所依赖的最小菜单接口。
 *
 * 只要满足这一组方法，菜单就能被填充：Obsidian 原生 `Menu`（若将来需要）与
 * DIA 自己的 DOM 菜单 {@link DomMenu} 都符合，构建器不必关心落在哪种实现上。
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
