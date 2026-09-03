import { setIcon } from 'obsidian';
import type { MenuLike, MenuLikeItem } from '../vendor/pixelPerfectImage/ui/MenuLike';

/**
 * Native-looking DOM menu that doubles as a `MenuLike` so the vendored PP
 * menu builders can populate it. Keeps Obsidian's native look by reusing its
 * CSS variables and `setIcon`, while giving DragImageAutoArrange full control
 * over nesting (Obsidian's Menu API has no submenu support).
 */

// ── Global open-menu registry + outside/Escape closing ─────────────────────
let openMenus: DomMenu[] = [];
let outsideCleanup: (() => void) | null = null;

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
let bridgeTimer: ReturnType<typeof setTimeout> | null = null;

function clearBridgeTimer(): void {
    if (bridgeTimer !== null) {
        clearTimeout(bridgeTimer);
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
    bridgeTimer = setTimeout(() => {
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

    const onDocClick = (e: MouseEvent): void => {
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

    // Defer so the opening event (a contextmenu / click that produced this menu)
    // can never be mistaken for an outside click. If the menu was already closed
    // by the time the timer fires, don't attach stale listeners.
    setTimeout(() => {
        if (openMenus.length === 0) return;
        document.addEventListener('click', onDocClick, false);
        document.addEventListener('keydown', onKey, false);
        window.addEventListener('resize', onResize);
        outsideCleanup = () => {
            document.removeEventListener('click', onDocClick);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
        };
    }, 0);
}

// ── Row building ────────────────────────────────────────────────────────────
export function createMenuRowEl(title: string, icon: string | null, caret = false): HTMLElement {
    const row = document.createElement('div');
    row.className = 'diaa-menu-item';
    row.setAttribute('role', 'menuitem');

    const iconBox = document.createElement('span');
    iconBox.className = 'diaa-menu-icon';
    if (icon) setIcon(iconBox, icon);
    row.appendChild(iconBox);

    const titleBox = document.createElement('span');
    titleBox.className = 'diaa-menu-title';
    titleBox.textContent = title;
    row.appendChild(titleBox);

    if (caret) {
        const caretBox = document.createElement('span');
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
        this.rootEl = document.createElement('div');
        this.rootEl.className = 'diaa-menu';
        this.rootEl.setAttribute('role', 'menu');
    }

    addSeparator(): this {
        const sep = document.createElement('div');
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
        this.rootEl.style.visibility = 'hidden';
        this.rootEl.style.left = '0px';
        this.rootEl.style.top = '0px';
        const rect = this.rootEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = clientX;
        let top = clientY;
        if (left + rect.width > vw - 8) left = Math.max(8, vw - rect.width - 8);
        if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
        this.rootEl.style.visibility = 'visible';
        this.rootEl.style.left = `${Math.max(8, left)}px`;
        this.rootEl.style.top = `${Math.max(8, top)}px`;
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

    /** Attach beside a parent row (submenu), flushing the right edge inward. */
    showBeside(anchorRect: DOMRect): void {
        document.body.appendChild(this.rootEl);
        registerMenu(this);
        this.rootEl.style.visibility = 'hidden';
        this.rootEl.style.left = '0px';
        this.rootEl.style.top = '0px';
        const rect = this.rootEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = anchorRect.right;
        if (left + rect.width > vw - 8) left = Math.max(8, anchorRect.left - rect.width);
        let top = anchorRect.top;
        if (top + rect.height > vh - 8) top = Math.max(8, vh - rect.height - 8);
        this.rootEl.style.visibility = 'visible';
        this.rootEl.style.left = `${Math.max(8, left)}px`;
        this.rootEl.style.top = `${Math.max(8, top)}px`;
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
    const parentMenu = parentRow.closest('.diaa-menu') as HTMLElement | null;
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
