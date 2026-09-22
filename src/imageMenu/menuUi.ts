import { setIcon } from 'obsidian';
import type { MenuLike, MenuLikeItem } from './menuLike';

/**
 * Native-looking DOM menu that doubles as a `MenuLike` so the menu builders
 * can populate it. Keeps Obsidian's native look by reusing its CSS variables
 * and `setIcon`, while giving DragImageAutoArrange full control over nesting
 * (Obsidian's Menu API has no submenu support).
 */

// ── Global open-menu registry + outside/Escape closing ─────────────────────
let openMenus: DomMenu[] = [];
let outsideCleanup: (() => void) | null = null;

// ── Shared UI scale (right-click menu size setting) ────────────────────────
// Applied as `transform: scale()` (origin top-left) on every menu container so
// padding, spacing, font and icon sizes scale together while the menu's fixed
// coordinates stay viewport-true (CSS `zoom` would scale those offsets too, so
// it is avoided). The submenu (separate `.diaa-menu`) reads it too, so a
// top-level menu and its hover submenu always share the same size.
let menuScale = 1;

/** Set the shared scale for every menu this module creates (1 = 100%). */
export function setMenuScale(scale: number): void {
  menuScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
}

// ── Hover-submenu host state ────────────────────────────────────────────────
// A caret'd parent row and its open submenu form one hover region. At most one
// such submenu is open per menu tree; the host fields record whose it is. When
// the pointer slides between adjacent caret parents, the arriving parent takes
// the submenu over (open-new-then-drop-old in one event batch) so the note
// underneath never flashes through a "both closed" gap. The bridge timer only
// covers a pointer pausing in the menu's own gutter while no parent takes over.
const caretParents = new WeakSet<HTMLElement>();
const delegatedMenus = new WeakSet<HTMLElement>();
let hoverParent: HTMLElement | null = null;
let hoverClose: (() => void) | null = null;
let bridgeTimer: number | null = null;

function clearBridgeTimer(): void {
    if (bridgeTimer !== null) {
        window.clearTimeout(bridgeTimer);
        bridgeTimer = null;
    }
}

/** Close the open hover submenu (if any) and clear its host state. */
function dismissHoverSub(): void {
    clearBridgeTimer();
    const close = hoverClose;
    hoverParent = null;
    hoverClose = null;
    close?.();
}

/** Wait briefly for an adjacent caret parent to take over; else close. */
function scheduleBridgeClose(delayMs: number): void {
    clearBridgeTimer();
    bridgeTimer = window.setTimeout(() => {
        bridgeTimer = null;
        dismissHoverSub();
    }, delayMs);
}

/** Landing on a plain (non-caret) row drops the current submenu at once. */
function onParentMenuHover(ev: MouseEvent): void {
    if (!hoverParent) return;
    const t = ev.target;
    if (!(t instanceof Element)) return;
    if (hoverParent.contains(t)) return;
    const rowEl = t.closest('.diaa-menu-item');
    if (!rowEl || caretParents.has(rowEl as HTMLElement)) return;
    dismissHoverSub();
}

function ensureHoverDelegate(menu: HTMLElement): void {
    if (delegatedMenus.has(menu)) return;
    delegatedMenus.add(menu);
    menu.addEventListener('mouseover', onParentMenuHover);
}

export function closeAllMenus(): void {
    outsideCleanup?.();
    outsideCleanup = null;
    hoverParent = null;
    hoverClose = null;
    clearBridgeTimer();
    for (const menu of openMenus) menu.rootEl.remove();
    openMenus = [];
}

function registerMenu(menu: DomMenu): void {
    openMenus.push(menu);
    if (outsideCleanup) return;

    // Outside-dismiss on the document CAPTURE phase of `mousedown`. Capture runs
    // before any target/bubble handler, so a Reading-Mode element that calls
    // stopPropagation on a click can no longer swallow the dismiss (it did when
    // this listened on bubble-phase `click`, leaving the menu open forever).
    const onDocMouseDown = (e: MouseEvent): void => {
        const target = e.target as Node;
        if (openMenus.some(menu => menu.rootEl.contains(target))) return;
        closeAllMenus();
    };
    const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAllMenus();
        }
    };
    const onResize = (): void => closeAllMenus();

    // Defer so the opening event (a contextmenu / the mousedown that produced
    // this menu) can never be mistaken for an outside click. If the menu was
    // already closed by the time the timer fires, don't attach stale listeners.
    window.setTimeout(() => {
        if (openMenus.length === 0) return;
        document.addEventListener('mousedown', onDocMouseDown, true);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onResize);
        outsideCleanup = () => {
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onResize);
        };
    }, 0);
}

/**
 * Shift a menu's desired top-left so the whole menu stays inside the viewport.
 * Both axes clamp independently with a shared inset; a menu wider/taller than the
 * viewport degrades to flush against the inset edge rather than overflowing.
 */
function fitToViewport(
    desiredLeft: number,
    desiredTop: number,
    width: number,
    height: number,
    vw: number,
    vh: number,
    inset = 8
): { left: number; top: number } {
    let left = desiredLeft;
    let top = desiredTop;
    if (left < inset) left = inset;
    if (left + width > vw - inset) left = Math.max(inset, vw - inset - width);
    if (top < inset) top = inset;
    if (top + height > vh - inset) top = Math.max(inset, vh - inset - height);
    return { left, top };
}

// ── Row building ────────────────────────────────────────────────────────────
export function createMenuRowEl(title: string, icon: string | null, caret = false): HTMLElement {
    const row = createDiv();
    row.className = 'diaa-menu-item';
    row.setAttribute('role', 'menuitem');

    const iconBox = createSpan();
    iconBox.className = 'diaa-menu-icon';
    if (icon) setIcon(iconBox, icon);
    row.appendChild(iconBox);

    const titleBox = createSpan();
    titleBox.className = 'diaa-menu-title';
    titleBox.textContent = title;
    row.appendChild(titleBox);

    if (caret) {
        const caretBox = createSpan();
        caretBox.className = 'diaa-menu-caret';
        setIcon(caretBox, 'chevron-right');
        row.appendChild(caretBox);
    }
    return row;
}

class MenuRowSpec implements MenuLikeItem {
    title: string | DocumentFragment | HTMLElement = '';
    icon: string | null = null;
    disabled = false;
    warning = false;
    onClickHandler: (() => void) | null = null;

    setTitle(title: string | DocumentFragment | HTMLElement): this {
        this.title = title;
        return this;
    }
    setIcon(icon: string): this {
        this.icon = icon;
        return this;
    }
    setDisabled(disabled: boolean): this {
        this.disabled = disabled;
        return this;
    }
    setWarning(warning: boolean): this {
        this.warning = warning;
        return this;
    }
    onClick(callback: () => void): this {
        this.onClickHandler = callback;
        return this;
    }
}

function buildRowFromSpec(spec: MenuRowSpec): HTMLElement {
    const el = createMenuRowEl(typeof spec.title === 'string' ? spec.title : '', spec.icon);
    if (spec.title instanceof HTMLElement || spec.title instanceof DocumentFragment) {
        el.querySelector('.diaa-menu-title')?.appendChild(spec.title.cloneNode(true));
    }
    if (spec.disabled) {
        el.classList.add('diaa-menu-item-disabled');
        el.setAttribute('aria-disabled', 'true');
    }
    if (spec.warning) el.classList.add('diaa-menu-warning');
    return el;
}

// ── Menu container ──────────────────────────────────────────────────────────
export class DomMenu implements MenuLike {
    readonly rootEl: HTMLElement;

    constructor() {
        this.rootEl = createDiv();
        this.rootEl.className = 'diaa-menu';
        this.rootEl.setAttribute('role', 'menu');
        // Scale via transform, NOT CSS zoom: Chromium multiplies the offsets of a
        // zoomed fixed element by the zoom factor (left:100 at zoom 1.5 paints at
        // 150), so a scaled menu would drift off the cursor/anchor. transform keeps
        // the fixed coordinates intact and scales content from the top-left corner,
        // which is exactly the anchor showAt/showBeside set.
        this.rootEl.setCssStyles({ transformOrigin: 'top left' });
        this.rootEl.style.transform = `scale(${menuScale})`;
        // The menu is a plain div appended to `document.body`, so a mousedown on
        // a row would move focus out of the editor (Chromium blurs the focused
        // element when the new target cannot take focus). Obsidian's CodeMirror
        // drops every keydown whose target lies outside `.cm-content`
        // (`eventBelongsToEditor`), so the Cmd+Z that follows a menu action
        // would never reach the editor and undo would silently do nothing.
        // Cancelling the default keeps focus AND the caret untouched; `click`
        // still fires, so row actions are unaffected.
        this.rootEl.addEventListener('mousedown', (e) => e.preventDefault());
    }

    addSeparator(): this {
        const sep = createDiv();
        sep.className = 'diaa-menu-sep';
        this.rootEl.appendChild(sep);
        return this;
    }

    addItem(callback: (item: MenuLikeItem) => unknown): this {
        const spec = new MenuRowSpec();
        callback(spec);
        const el = buildRowFromSpec(spec);
        el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (spec.disabled) return;
            closeAllMenus();
            spec.onClickHandler?.();
        });
        this.rootEl.appendChild(el);
        return this;
    }

    /** Append a pre-built row (e.g. a submenu parent with custom hover logic). */
    appendRowEl(rowEl: HTMLElement): this {
        this.rootEl.appendChild(rowEl);
        return this;
    }

    /** Attach to the document at cursor coordinates with viewport clamping. */
    showAt(clientX: number, clientY: number): void {
        document.body.appendChild(this.rootEl);
        registerMenu(this);
        this.rootEl.setCssStyles({ visibility: 'hidden' });
        this.rootEl.setCssStyles({ left: '0px' });
        this.rootEl.setCssStyles({ top: '0px' });
        const rect = this.rootEl.getBoundingClientRect();
        const { left, top } = fitToViewport(
            clientX, clientY, rect.width, rect.height,
            window.innerWidth, window.innerHeight
        );
        this.rootEl.setCssStyles({ visibility: 'visible' });
        this.rootEl.style.left = `${left}px`;
        this.rootEl.style.top = `${top}px`;
    }

    /** Remove this menu without touching the others (used for hover submenus). */
    close(): void {
        openMenus = openMenus.filter(menu => menu !== this);
        this.rootEl.remove();
        if (openMenus.length === 0) {
            outsideCleanup?.();
            outsideCleanup = null;
        }
    }

    /**
     * Attach beside a parent row (submenu), tightly abutting the row's right edge
     * with the submenu's top aligned to the parent's top. When there is not enough
     * room on the right, the submenu flips to the parent's left side; a final
     * viewport clamp then guarantees the whole submenu stays visible.
     */
    showBeside(anchorRect: DOMRect): void {
        document.body.appendChild(this.rootEl);
        registerMenu(this);
        this.rootEl.setCssStyles({ visibility: 'hidden' });
        this.rootEl.setCssStyles({ left: '0px' });
        this.rootEl.setCssStyles({ top: '0px' });
        const rect = this.rootEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const inset = 8;
        // Choose the side with enough room, preferring right (tight abutment);
        // if neither fits, pick the larger gap so the clamp shifts the least.
        const spaceRight = vw - inset - anchorRect.right;
        const spaceLeft = anchorRect.left - inset;
        let left: number;
        if (spaceRight >= rect.width) {
            left = anchorRect.right;
        } else if (spaceLeft >= rect.width) {
            left = anchorRect.left - rect.width;
        } else {
            left = spaceRight >= spaceLeft ? anchorRect.right : anchorRect.left - rect.width;
        }
        const desiredTop = anchorRect.top;
        const { left: fittedLeft, top } = fitToViewport(
            left, desiredTop, rect.width, rect.height, vw, vh, inset
        );
        this.rootEl.setCssStyles({ visibility: 'visible' });
        this.rootEl.style.left = `${fittedLeft}px`;
        this.rootEl.style.top = `${top}px`;
    }
}

/**
 * Wire a caret'd parent row to a hover submenu (Obsidian's native Menu API has
 * no submenu support, so we emulate it). Moving between adjacent caret parents
 * hands the open submenu from one to the next in the same event batch (open the
 * arriving parent's submenu, then drop the previous one), so the note beneath
 * never flashes. A short bridge timer only covers a pointer pausing in the
 * menu's own gutter; leaving the top-level menu — or landing on a plain
 * (non-caret) row — closes the submenu at once. `buildSub` is called lazily on
 * first open; each open builds a fresh submenu so its checked state is current.
 */
export function attachHoverSubmenu(
    parentRow: HTMLElement,
    buildSub: () => DomMenu,
    bridgeDelayMs = 100
): void {
    const parentMenu = parentRow.closest<HTMLElement>('.diaa-menu');
    caretParents.add(parentRow);
    if (parentMenu) ensureHoverDelegate(parentMenu);

    let sub: DomMenu | null = null;

    const closeOwnSub = (): void => {
        if (sub) {
            sub.close();
            sub = null;
        }
    };
    const inOwnRegion = (node: Node | null): boolean => {
        if (!node) return false;
        if (parentRow.contains(node)) return true;
        if (sub && sub.rootEl.contains(node)) return true;
        return false;
    };
    const handleLeave = (ev: MouseEvent): void => {
        if (hoverParent !== parentRow) return; // already dismissed / taken over
        const next = ev.relatedTarget;
        if (next instanceof Node && inOwnRegion(next)) {
            clearBridgeTimer(); // crossing into our own submenu or back onto the row
            return;
        }
        if (!(next instanceof Element)) {
            dismissHoverSub(); // left to the window
            return;
        }
        const nextMenu = next.closest('.diaa-menu');
        if (parentMenu === null || nextMenu !== parentMenu) {
            dismissHoverSub(); // left the top-level menu entirely
            return;
        }
        // Still inside the top-level menu (an adjacent caret parent, a plain
        // row, or the 1px gutter between rows): give the next parent a beat to
        // take over before we drop the current submenu.
        scheduleBridgeClose(bridgeDelayMs);
    };
    const showSub = (): void => {
        if (hoverParent && hoverParent !== parentRow) dismissHoverSub();
        clearBridgeTimer();
        if (sub) return;
        sub = buildSub();
        sub.rootEl.addEventListener('mouseenter', clearBridgeTimer);
        sub.rootEl.addEventListener('mouseleave', handleLeave);
        sub.showBeside(parentRow.getBoundingClientRect());
        hoverParent = parentRow;
        hoverClose = closeOwnSub;
    };

    parentRow.addEventListener('mouseenter', showSub);
    parentRow.addEventListener('mouseleave', handleLeave);
    parentRow.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (hoverParent === parentRow && sub) dismissHoverSub();
        else showSub();
    });
}
