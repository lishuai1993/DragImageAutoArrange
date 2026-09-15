// ── Row-field model: type-self-describing parse/serialize boundary ──────
// The multi-image rows and single-image rows both persist a per-member embed
// line `![[file|...params]]`.  The SAME parameter slot order means different
// quantities per row kind, and a single row additionally swaps S/W relative to
// a multi row — Obsidian's native reading-mode renderer reads the LAST numeric
// as the width, so a single row must put its real pixel width last.
//
// All of that positional dirt — plus the ×100 / ÷100 scaling — lives ONLY in
// read()/write() below.  Consumers get a discriminated RowImage whose `display`
// already declares which quantity each number is (kind = multi/single-follow/
// single-manual), so they never branch on group size or sniff numeric sentinels.
//
// A leading rotate/flip word (see ORIENTATION_WORDS) may open the params of
// either kind.  It must precede every number — Obsidian's own renderer reads the
// LAST numeric as the width, so the word can never sit between numbers.

import { buildImageLineRe } from "../constants";
import { stripEmbedParams } from "./embedRaw";
import {
  IDENTITY_STATE,
  isOrientationWord,
  orientationWord,
  parseOrientationWord,
  type OrientationState,
} from "../imageTransform/orientation";

export type Alignment = "left" | "center" | "right";
export type RowKind = "multi" | "single";

export type ImageDisplay =
  | { kind: "multi"; share: number; fill: number | null }
  //  行宽份额 (flexGrow)      列内填充比 (scale)，null = 满格默认
  | { kind: "single-follow" }                 // S=0 跟随设置
  | { kind: "single-manual"; widthPx: number }; // S=1 绝对像素宽

export interface RowImage {
  line: number;
  raw: string;
  fileName: string;
  alignment?: Alignment;
  /** Displayed rotate/flip orientation, read from the row's leading word.
   *  Identity both when the word is absent and when it reads `orig`. */
  orientation: OrientationState;
  /** Whether the persisted embed line carries explicit numeric sizing for this
   *  row kind (a multi share code, or the single `|S|W` tail).  Bare / legacy /
   *  alignment-only lines are false so layout may auto-backfill from natural
   *  aspect ratios.  Single-sense (never a unit), mutable live scratch on the
   *  renderer side once a row has materialised its params. */
  hasSizing: boolean;
  display: ImageDisplay;
}

export interface RowImageOptions {
  /** Pixel width to serialise for a single-follow (S=0) row.  The model keeps
   *  no width there (it follows the setting); only the writer needs one because
   *  the persisted form is always `|S|W`.  Falls back to the existing `|0|W`
   *  width in `raw` when omitted. */
  followWidthPx?: number;
}

const ALIGN_WORDS: ReadonlySet<string> = new Set(["left", "center", "right"]);
const RE_LEADING_NUM = /(?:^|\|)(\d+)/;
const RE_TRAILING_NUM = /\|(\d+)$/;

/** Whether a token is one of the alignment words.  Exported so a line-level
 *  policy can tell an alignment slot apart from a token it doesn't own. */
export function isAlignmentWord(token: string | undefined): token is Alignment {
  return token !== undefined && ALIGN_WORDS.has(token);
}

/** Split the pipe params of an embed line into ordered string parts.  [] bare. */
function splitTokens(paramStr: string): string[] {
  if (paramStr === "") return [];
  return paramStr.split("|");
}

/** Multi alignment: the align word only counts when a `|` follows it.
 *  `left|120` → left, a lone `left` → undefined. */
function multiAlign(tokens: string[], offset: number): Alignment | undefined {
  const tok = tokens[offset];
  return tok !== undefined && ALIGN_WORDS.has(tok) && tokens.length > offset + 1
    ? (tok as Alignment)
    : undefined;
}

/** Single alignment: the align word regardless of trailing params. */
function singleAlign(tokens: string[], offset: number): Alignment | undefined {
  const tok = tokens[offset];
  return tok !== undefined && ALIGN_WORDS.has(tok) ? (tok as Alignment) : undefined;
}

/** Offset of the first numeric slot, past the orientation word and the align
 *  word. The two are positionally ordered (orientation, then alignment) and
 *  each may be absent, so the offset is a two-step prefix — never a fixed 1. */
function slotOffset(tokens: string[]): number {
  let offset = isOrientationWord(tokens[0]) ? 1 : 0;
  if (ALIGN_WORDS.has(tokens[offset])) offset += 1;
  return offset;
}

function parseMultiDisplay(paramStr: string): ImageDisplay {
  // First numeric = share code (flexGrow × 100); last |numeric = fill code.
  // One numeric (or none) must not double-assign — fill stays null so layout
  // can backfill it from rendered state.
  const firstNum = paramStr !== "" ? paramStr.match(RE_LEADING_NUM) : null;
  const explicitWidth = firstNum ? parseInt(firstNum[1], 10) : null;
  const scaleMatch = paramStr !== "" ? paramStr.match(RE_TRAILING_NUM) : null;
  const sameOccurrence = firstNum && scaleMatch && firstNum.index === scaleMatch.index;
  const scale = scaleMatch && !sameOccurrence ? parseInt(scaleMatch[1], 10) / 100 : null;
  return { kind: "multi", share: explicitWidth !== null ? explicitWidth / 100 : 1, fill: scale };
}

function parseSingleDisplay(tokens: string[], offset: number): ImageDisplay {
  // Our single `|S|W` form: S is exactly 0/1, W is the real pixel width.
  // Anything else (bare, legacy `|W`, `|WxH`, or a multi-leftover `|W|S` where
  // the first param isn't 0/1) is not a manual single yet → single-follow.
  if (tokens.length >= offset + 2) {
    const s = parseInt(tokens[offset], 10);
    if (s === 0) return { kind: "single-follow" };
    if (s === 1) {
      const w = parseInt(tokens[offset + 1], 10);
      return { kind: "single-manual", widthPx: isFinite(w) && w > 0 ? w : 1 };
    }
  }
  return { kind: "single-follow" };
}

function parseLine(
  raw: string,
  line: number,
  kind: RowKind,
  re: RegExp
): RowImage | null {
  const match = raw.match(re);
  if (!match) return null;
  const fileName = match[1];
  const paramStr = match[2] ?? "";
  const tokens = splitTokens(paramStr);

  const orientation = parseOrientationWord(paramStr) ?? IDENTITY_STATE;
  const oriOffset = isOrientationWord(tokens[0]) ? 1 : 0;
  const alignment =
    kind === "multi" ? multiAlign(tokens, oriOffset) : singleAlign(tokens, oriOffset);
  const offset = oriOffset + (alignment ? 1 : 0);
  const display =
    kind === "multi"
      ? parseMultiDisplay(paramStr)
      : parseSingleDisplay(tokens, offset);

  // "Has explicit numeric sizing" mirrors the legacy per-kind flag exactly:
  //  multi — a share code present anywhere;
  //  single — a `|S|W` tail with S ∈ {0,1}.
  const hasSizing =
    kind === "multi"
      ? RE_LEADING_NUM.test(paramStr)
      : tokens.length >= offset + 2 &&
        (tokens[offset] === "0" || tokens[offset] === "1");

  return { line, raw, fileName, alignment, orientation, hasSizing, display };
}

/**
 * Parse a row's text into one RowImage per image line.  `kind` states whether
 * the row is multi (≥2 members) or single (1 member) — read once, no two-pass
 * guessing.  `lineBase` is added to each index so `line` can be absolute.
 */
export function read(
  rowText: string,
  kind: RowKind,
  extensions: string,
  lineBase = 0
): RowImage[] {
  const re = buildImageLineRe(extensions);
  const out: RowImage[] = [];
  rowText.split("\n").forEach((raw, i) => {
    const img = parseLine(raw, lineBase + i, kind, re);
    if (img) out.push(img);
  });
  return out;
}

/** Reconstruct the `|S|W` pixel width already stored on a single-follow row,
 *  so a follow row can round-trip without an explicit width. */
function storedFollowWidth(raw: string): number | null {
  const m = raw.match(/\|([^\]]*)\]\]/);
  if (!m) return null;
  const tokens = m[1].split("|");
  const offset = slotOffset(tokens);
  if (tokens.length >= offset + 2 && (tokens[offset] === "0" || tokens[offset] === "1")) {
    const w = parseInt(tokens[offset + 1], 10);
    if (isFinite(w) && w > 0) return w;
  }
  return null;
}

/**
 * The orientation params to prepend. Always written, identity included: an
 * image at its original orientation lands on an explicit `orig` rather than an
 * absent slot, so no reader has to infer a default. See the 槽位恒满 emission
 * policy in the design doc (旋转翻转文档 §2.5 / §8.2).
 */
function orientationParams(img: RowImage): string[] {
  return [orientationWord(img.orientation)];
}

function serializeMulti(img: RowImage): string {
  const base = stripEmbedParams(img.raw);
  if (img.display.kind !== "multi") return base;
  const { share, fill } = img.display;

  // Slots are always filled: orientation word, the alignment word when the
  // model carries one, and the share code — a uniform 1.0 is written as `100`,
  // never omitted. The fill code follows only when a measured ratio exists: an
  // unmeasured row (image not loaded yet, or a broken link) is written with the
  // three leading slots and has its fill appended once it can be measured.
  const params: string[] = orientationParams(img);
  if (img.alignment) params.push(img.alignment);
  params.push(String(Math.round(share * 100)));
  if (fill != null && fill > 0) {
    const scaleValue = Math.round(Math.min(1, fill) * 100);
    if (scaleValue > 0 && scaleValue <= 100) params.push(String(scaleValue));
  }
  return base.replace(/\]\]/, `|${params.join("|")}]]`);
}

function serializeSingle(
  img: RowImage,
  widthPx: number,
  sFlag: "0" | "1"
): string {
  const base = stripEmbedParams(img.raw);
  const w = Math.max(1, Math.round(widthPx));
  const params = orientationParams(img);
  if (img.alignment) params.push(img.alignment);
  params.push(sFlag, String(w));
  return base.replace(/\]\]/, `|${params.join("|")}]]`);
}

/** Serialise a RowImage back to its `![[file|...]]` line text. */
export function write(img: RowImage, opts: RowImageOptions = {}): string {
  if (img.display.kind === "multi") return serializeMulti(img);

  if (img.display.kind === "single-manual") {
    return serializeSingle(img, img.display.widthPx, "1");
  }

  const widthPx =
    opts.followWidthPx != null
      ? opts.followWidthPx
      : (storedFollowWidth(img.raw) ?? 1);
  return serializeSingle(img, widthPx, "0");
}
