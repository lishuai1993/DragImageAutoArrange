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

export function closeAllMenus(): void {
    outsideCleanup?.();
    outsideCleanup = null;
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
