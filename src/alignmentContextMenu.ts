/**
 * Custom cascading alignment menu — built entirely with DOM elements
 * to bypass Obsidian's Menu API limitations (no native submenu support,
 * click-to-close handler interferes with hover behavior).
 */

import { logger } from "./logger";

// ── Global singleton state for cleanup ──
let activeEls: HTMLElement[] = [];
let activeCleanup: (() => void) | null = null;

function closeAll(): void {
  activeCleanup?.();
  activeCleanup = null;
  for (const el of activeEls) el.remove();
  activeEls = [];
}

export function showImageAlignmentMenu(
  event: MouseEvent,
  currentAlignment: "left" | "center" | "right" | undefined,
  onAlign: (alignment: "left" | "center" | "right" | undefined) => void
): void {
  logger.info("CTXMENU showImageAlignmentMenu called", { currentAlignment, x: event.clientX, y: event.clientY });
  closeAll();

  // ── Styles matching Obsidian's native menu ──
  const itemCSS =
    "padding:4px 12px;margin:0;font-size:var(--font-ui-small,13px);" +
    "line-height:1.5;cursor:default;white-space:nowrap;" +
    "color:var(--text-normal);border-radius:4px;user-select:none;";

  const menuCSS =
    "position:fixed;z-index:var(--layer-menu,9999);" +
    "background:var(--background-primary);" +
    "border:1px solid var(--background-modifier-border);" +
    "border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,0.16);" +
    "padding:4px;display:flex;flex-direction:column;gap:1px;";

  const hoverBg = "var(--background-modifier-hover)";

  const addHover = (el: HTMLElement) => {
    el.addEventListener("mouseenter", () => { el.style.background = hoverBg; });
    el.addEventListener("mouseleave", () => { el.style.background = ""; });
  };

  // ── Submenu ──
  function createSubmenu(): HTMLElement {
    const box = document.createElement("div");
    box.style.cssText = menuCSS + "min-width:150px;";
    activeEls.push(box);

    const items: Array<{ label: string; align: "left" | "center" | "right" | undefined }> = [
      { label: "Left", align: "left" },
      { label: "Center", align: "center" },
      { label: "Right", align: "right" },
    ];

    for (const { label, align } of items) {
      const el = document.createElement("div");
      const checked = currentAlignment === align;
      el.textContent = `${checked ? "✓ " : "   "}${label}`;
      el.style.cssText = itemCSS;
      addHover(el);
      el.addEventListener("click", (ce) => {
        ce.stopPropagation();
        closeAll();
        onAlign(align);
      });
      box.appendChild(el);
    }

    // Separator
    const sep = document.createElement("div");
    sep.style.cssText = "height:1px;background:var(--background-modifier-border);margin:2px 4px;";
    box.appendChild(sep);

    // Reset
    const reset = document.createElement("div");
    reset.textContent = `${currentAlignment === undefined ? "✓ " : "   "}Reset to default`;
    reset.style.cssText = itemCSS;
    addHover(reset);
    reset.addEventListener("click", (ce) => {
      ce.stopPropagation();
      closeAll();
      onAlign(undefined);
    });
    box.appendChild(reset);

    return box;
  }

  // ── Main popup ──
  const main = document.createElement("div");
  main.style.cssText = menuCSS;
  main.style.left = `${event.clientX}px`;
  main.style.top = `${event.clientY}px`;
  activeEls.push(main);

  const mainItem = document.createElement("div");
  mainItem.textContent = "Align image ▸";
  mainItem.style.cssText = itemCSS;
  addHover(mainItem);
  main.appendChild(mainItem);

  let submenu: HTMLElement | null = null;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  };

  const hideSub = () => {
    if (submenu) {
      submenu.remove();
      activeEls = activeEls.filter(e => e !== submenu);
      submenu = null;
    }
  };

  const showSub = () => {
    clearTimer();
    if (submenu) return;
    submenu = createSubmenu();
    const r = mainItem.getBoundingClientRect();
    submenu.style.left = `${r.right + 4}px`;
    submenu.style.top = `${r.top}px`;
    document.body.appendChild(submenu);

    submenu.addEventListener("mouseenter", clearTimer);
    submenu.addEventListener("mouseleave", () => {
      closeTimer = setTimeout(hideSub, 200);
    });
  };

  mainItem.addEventListener("mouseenter", showSub);
  mainItem.addEventListener("mouseleave", () => {
    closeTimer = setTimeout(hideSub, 200);
  });

  document.body.appendChild(main);
  logger.info("CTXMENU menu appended", { connected: main.isConnected });

  // ── Global cleanup listeners ──
  const onClickOutside = (e: MouseEvent) => {
    if (main.contains(e.target as Node)) return;
    if (submenu?.contains(e.target as Node)) return;
    closeAll();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") closeAll();
  };

  // Defer registration so the current right-click doesn't immediately
  // trigger click-outside via capture.
  setTimeout(() => {
    document.addEventListener("click", onClickOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);

  activeCleanup = () => {
    document.removeEventListener("click", onClickOutside, true);
    document.removeEventListener("keydown", onKey, true);
  };
}
