/**
 * Mobile presentation for DIAA rows.
 *
 * A touch device does not compose rows side by side: every image takes its own
 * line and is fitted to the page width, the way Obsidian draws a bare embed.
 * Both render paths hand their matched embeds to this module, which owns the
 * one thing that has to be computed rather than declared — the box an image
 * occupies once its persisted rotate/flip is replayed.
 *
 * Nothing here writes the note.  Obsidian reads an embed's last numeric slot as
 * a `width` attribute; the attribute is removed and the display box is written
 * as plain inline style, so the stylesheet needs no `!important` to outrank
 * either the attribute or a theme's ordinary rules.
 */
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { CLASSES } from "../constants";
import { logger } from "../logger";
import {
  IDENTITY_STATE,
  orientedSize,
  parseOrientationWord,
  type OrientationState,
} from "../imageTransform/orientation";
import {
  applyOrientationPreview,
  boxForScreenWidth,
  displayedImageSize,
} from "../imageTransform/transformPreview";
import {
  mediaLoaded,
  mediaNaturalSize,
  onMediaReady,
  queryAllMedia,
  type MediaElement,
} from "../imageMedia/mediaElement";

const log = logger.channel("mobileStack");

export interface MobileBoxPlan {
  /** The un-rotated box the bitmap is painted in. */
  boxWidth: number;
  boxHeight: number;
  /** The rectangle the reader sees (equal to the box for even orientations). */
  shownWidth: number;
  shownHeight: number;
  /** Fit factor the quarter turn hands to the transform; 1 for even turns. */
  scale: number;
  turned: boolean;
}

/**
 * Size one image for the stacked layout.  `naturalWidth` / `naturalHeight` are
 * the bitmap's own pixels; the display width is the bitmap's width in the
 * orientation it is shown in, never enlarged past its own size and never wider
 * than the page.  Pure, so the arithmetic is testable without a DOM.
 */
export function planMobileBox(
  naturalWidth: number,
  naturalHeight: number,
  containerWidth: number,
  state: OrientationState
): MobileBoxPlan | null {
  if (naturalWidth <= 0 || naturalHeight <= 0 || containerWidth <= 0) return null;
  const aspect = naturalWidth / naturalHeight;
  const naturalScreenWidth = orientedSize(state, naturalWidth, naturalHeight).width;
  const screenWidth = Math.min(naturalScreenWidth, containerWidth);
  const box = boxForScreenWidth(screenWidth, aspect, state);
  const boxWidth = Math.max(1, Math.round(box.width));
  const boxHeight = Math.max(1, Math.round(box.height));
  const shown = displayedImageSize(boxWidth, boxHeight, state, containerWidth);
  return {
    boxWidth,
    boxHeight,
    shownWidth: Math.max(1, Math.round(shown.width)),
    shownHeight: Math.max(1, Math.round(shown.height)),
    scale: shown.scale,
    turned: state.turns % 2 === 1,
  };
}

/**
 * The orientation an embed displays.  Reading Mode writes the word onto the
 * embed; Live Preview puts it on the line decoration, so the closest carrier
 * wins.  A missing word is identity.
 */
export function mobileOrientationOf(embed: HTMLElement): OrientationState {
  const word =
    embed.getAttribute("data-diaa-orientation") ??
    embed.closest<HTMLElement>("[data-diaa-orientation]")?.getAttribute("data-diaa-orientation") ??
    "";
  return parseOrientationWord(word) ?? IDENTITY_STATE;
}

const lastPlan = new WeakMap<MediaElement, string>();
const widthWatched = new WeakSet<HTMLElement>();

/**
 * Present one embed for the stacked layout.  Safe to call repeatedly: the
 * measurements are cached per media element, unloaded media wait for their
 * size, and a resize of the host re-runs the sizing.
 */
export function layoutMobileEmbed(embed: HTMLElement): void {
  const state = mobileOrientationOf(embed);
  const turned = state.turns % 2 === 1;
  embed.classList.toggle(CLASSES.mobileTurned, turned);

  const host = embed.parentElement;
  const containerWidth = Math.round(host?.getBoundingClientRect().width ?? 0);
  watchHostWidth(embed, host);

  for (const media of queryAllMedia(embed)) {
    if (!mediaLoaded(media)) {
      onMediaReady(media, () => layoutMobileEmbed(embed));
      continue;
    }
    const { w, h } = mediaNaturalSize(media);
    const plan = planMobileBox(w, h, containerWidth, state);
    if (!plan) continue;

    const key = `${containerWidth}|${plan.boxWidth}x${plan.boxHeight}|${state.turns}:${state.mirror}`;
    if (lastPlan.get(media) === key) continue;
    lastPlan.set(media, key);
    writePlan(media, embed, state, plan);
    log.debug("mobile layout", {
      fileName: embed.getAttribute("src") ?? "",
      containerWidth,
      natural: { w, h },
      orientation: `${state.turns}:${state.mirror}`,
      plan,
    });
  }
}

function writePlan(
  media: MediaElement,
  embed: HTMLElement,
  state: OrientationState,
  plan: MobileBoxPlan
): void {
  // Obsidian writes the embed's trailing number into these attributes; the
  // display box below replaces them, so they have to stop competing first.
  media.removeAttribute("width");
  media.removeAttribute("height");
  media.style.width = `${plan.boxWidth}px`;
  media.style.height = `${plan.boxHeight}px`;
  // A quarter turn needs a box wider than the page; a max-width would clamp it
  // and letterbox the bitmap the transform is measured against.
  media.style.maxWidth = plan.turned ? "none" : "100%";
  applyOrientationPreview(media, state, plan.turned ? { scale: plan.scale } : undefined);

  // The embed takes the drawn rectangle, so the oversized (pre-transform) box
  // is centred inside it rather than pushing the picture off the page.
  if (plan.turned) {
    embed.style.width = `${plan.shownWidth}px`;
    embed.style.height = `${plan.shownHeight}px`;
  } else {
    embed.style.removeProperty("width");
    embed.style.removeProperty("height");
  }
}

function watchHostWidth(embed: HTMLElement, host: HTMLElement | null): void {
  if (!host || widthWatched.has(embed)) return;
  if (typeof ResizeObserver === "undefined") return;
  widthWatched.add(embed);
  let lastWidth = Math.round(host.getBoundingClientRect().width);
  const observer = new ResizeObserver(() => {
    if (!embed.isConnected) {
      observer.disconnect();
      widthWatched.delete(embed);
      return;
    }
    const width = Math.round(host.getBoundingClientRect().width);
    if (width <= 0 || width === lastWidth) return;
    lastWidth = width;
    layoutMobileEmbed(embed);
  });
  observer.observe(host);
}

/**
 * Live Preview side of the stacked layout.
 *
 * The editor renders the embeds natively (the decoration only marks their
 * line), so this plugin's job is to catch the DOM as it appears and hand each
 * embed to `layoutMobileEmbed`.  A child-list observer covers embeds Obsidian
 * builds asynchronously after the line itself is in place; the update hook
 * covers scrolling and edits.
 */
export function createMobileStackPlugin(getOptions: () => { mobileStack?: boolean }) {
  return ViewPlugin.fromClass(
    class {
      private readonly view: EditorView;
      private frame: number | null = null;
      private observer: MutationObserver | null = null;

      constructor(view: EditorView) {
        this.view = view;
        // Desktop keeps the row widget and never reaches the stacked layout,
        // so it pays for neither the observer nor a rAF pass.
        if (!getOptions().mobileStack) return;
        if (typeof MutationObserver !== "undefined") {
          this.observer = new MutationObserver(() => this.schedule());
          this.observer.observe(view.contentDOM, { childList: true, subtree: true });
        }
        this.schedule();
      }

      update(update: ViewUpdate): void {
        if (update.docChanged || update.viewportChanged || update.geometryChanged) {
          this.schedule();
        }
      }

      destroy(): void {
        this.observer?.disconnect();
        this.observer = null;
        if (this.frame !== null && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(this.frame);
        }
        this.frame = null;
      }

      private schedule(): void {
        if (this.frame !== null) return;
        if (typeof window.requestAnimationFrame !== "function") return;
        this.frame = window.requestAnimationFrame(() => {
          this.frame = null;
          this.layout();
        });
      }

      private layout(): void {
        if (!getOptions().mobileStack) return;
        const rows = this.view.contentDOM.querySelectorAll<HTMLElement>(
          `.${CLASSES.mobileRow}`
        );
        for (const row of Array.from(rows)) {
          const embeds = row.querySelectorAll<HTMLElement>(".internal-embed");
          for (const embed of Array.from(embeds)) {
            embed.classList.add(CLASSES.mobileEmbed);
            layoutMobileEmbed(embed);
          }
        }
      }
    }
  );
}
