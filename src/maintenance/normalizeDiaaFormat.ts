// ── Vault-wide "normalise to the standard DIA form" policy ──────────────
// Puts every image line DIA can host into the standard slot layout: the two
// leading word slots get written in — an explicit orientation word (`orig` when
// the image stands upright) and the alignment word the row renders with — so a
// later rotate is a word-for-word replacement inside a row that already has its
// slots, instead of being the first write that grows the row's param run.
//
// Numeric slots are left exactly as they are.  A missing one is filled by the
// row's own first render, the only place that knows a member's share (derived
// from every member's natural pixel size) or a fill ratio (measured off the
// painted layout); a number invented here would be permanent, because an
// explicit share sets `hasSizing` and stops the render from ever deriving it.
//
// The one numeric this pass does touch is a single row's bare width: `|400` and
// `|400x300` are Obsidian's native sizing, which DIA's first render would
// otherwise overwrite with a setting-driven `|0|W`.  Promoting them to `|1|400`
// keeps the hand-written width as a manual one.
//
// A line whose params carry anything unrecognised — an alias, a size form on a
// multi member, a shape DIA never writes — is not ours to rewrite and is left
// byte-for-byte alone.  Only the policy lives here; the walk, the write channel
// and the progress reporting are ./vaultPass.

import type { Alignment } from "../constants";
import { detectRowGroups } from "../imageParse/imageDetector";
import { parseEmbedParams, stripEmbedParams } from "../imageParse/embedRaw";
import { isAlignmentWord, type RowKind } from "../imageParse/rowParams";
import { isOrientationWord } from "../imageTransform/orientation";
import type { LinePlan } from "./vaultPass";

export interface NormalizeOptions {
  /** Alignment written into rows that carry none of their own. */
  alignment: Alignment;
  /** Row chunking: a run longer than this is split, and a lone leftover member
   *  counts as a single row — exactly how the renderer classifies them. */
  maxImagesPerRow: number;
}

const INT = /^\d+$/;
const SIZE = /^(\d+)x\d+$/;

/** A single row's numeric tail, or null when the shape isn't one DIA accounts
 *  for.  Absent stays absent (the first render derives the width and the
 *  setting-driven `S`); a bare native width becomes a manual one. */
function readSingleTail(rest: string[]): string[] | null {
  if (rest.length === 0) return [];
  if (rest.length === 2) {
    const flag = rest[0];
    return (flag === "0" || flag === "1") && INT.test(rest[1]) ? rest : null;
  }
  if (rest.length === 1) {
    const size = SIZE.exec(rest[0]);
    if (size) return ["1", size[1]];
    return INT.test(rest[0]) && parseInt(rest[0], 10) > 0 ? ["1", rest[0]] : null;
  }
  return null;
}

/** A multi member's numeric tail: share code, fill code, both, or neither —
 *  carried over verbatim so a hand-adjusted share survives the pass. */
function readMultiTail(rest: string[]): string[] | null {
  if (rest.length > 2) return null;
  return rest.every((token) => INT.test(token)) ? rest : null;
}

function normalizeLine(raw: string, kind: RowKind, options: NormalizeOptions): string {
  const tokens = parseEmbedParams(raw) ?? [];
  let offset = 0;
  const orientation = isOrientationWord(tokens[0]) ? tokens[0] : null;
  if (orientation) offset = 1;
  // A multi member's alignment word only means anything when another param
  // follows it (see rowParams.multiAlign); a dangling one is not a slot we can
  // account for, so the line is left alone rather than restated as something
  // the parser would read differently.
  const alignment = isAlignmentWord(tokens[offset]) &&
    (kind === "single" || tokens.length > offset + 1)
    ? tokens[offset]
    : null;
  if (alignment) offset += 1;

  const rest = tokens.slice(offset);
  const tail = kind === "multi" ? readMultiTail(rest) : readSingleTail(rest);
  if (!tail) return raw;

  const params = [orientation ?? "orig", alignment ?? options.alignment, ...tail];
  const next = stripEmbedParams(raw).replace(/\]\]/, `|${params.join("|")}]]`);
  return next === raw ? raw : next;
}

/** Build the plan: every hostable image line gains its word slots, and lines
 *  already in the standard form simply don't appear in the result. */
export function makeNormalizePlan(options: NormalizeOptions): LinePlan {
  return (lines, extensions) => {
    const groups = detectRowGroups(lines.join("\n"), options.maxImagesPerRow, extensions);
    const out = new Map<number, string>();
    for (const group of groups) {
      for (const img of group.images) {
        const next = normalizeLine(img.raw, group.kind, options);
        if (next !== img.raw) out.set(img.line, next);
      }
    }
    return out;
  };
}
