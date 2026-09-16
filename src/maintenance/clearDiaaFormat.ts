// ── Vault-wide "clear DIAA format" policy ────────────────────────────────
// Restores every image reference DIAA wrote to Obsidian's own form, so an
// uninstalled DIAA leaves nothing behind.  This is the escape hatch the "slots
// are always filled" write policy needs — with every writable slot persisted, a
// multi-row member's last numeric would be read as a pixel width by Obsidian's
// own renderer once DIAA is gone.
//
// Two shapes of reference, because DIAA writes to them differently:
//
//  - A row: an image alone on its line.  DIAA hosts it, so the whole param run is
//    DIAA's (orientation / alignment / share / fill / the single `|S|W` tail) and
//    all of it goes back to `![[file]]`.
//  - An inline reference: an image embedded in prose, a list item or a quote.
//    DIAA never hosts these, and the one path that could reach them is the
//    reading-mode alignment flush (see rmAlignStore.flushPendingAlignments),
//    which drops a bare alignment word after the first `|` of any line naming
//    the file.  So only the leading word params go; Obsidian's own numeric
//    sizing stays, or clearing would silently resize the image.
//
// Only the policy lives here (which references are ours, what they become); the
// walk, the write channel and the progress reporting are ./vaultPass.

import { buildImageEmbedRe, buildImageLineRe } from "../constants";
import { parseEmbedParams, stripEmbedParams } from "../imageParse/embedRaw";
import { isAlignmentWord } from "../imageParse/rowParams";
import { isOrientationWord } from "../imageTransform/orientation";
import type { LinePlan } from "./vaultPass";

const NUMERIC = /^\d+$/;

/**
 * A param run is DIAA-managed when it opens with an orientation word, or carries
 * two or more numerics.  Everything else is left alone, because the clear is
 * irreversible and losing a hand-written value is worse than skipping a legacy
 * row:
 *
 *  - no params                        nothing to clear
 *  - `|400`                           a lone numeric is a native width, or a
 *                                     native `|W`; indistinguishable → keep
 *  - `|400x300`                       native size, not numeric → keep
 *  - `|center`                        alignment-only could be hand-written → keep
 *  - `|0|350`                         the `|S|W` tail — native never writes it
 *  - `|orig|center|100|67`            orientation word and two numerics
 *
 * `|left|120` (a DIAA row whose fill code was omitted) is intentionally kept for
 * the same reason as a lone numeric; once DIAA has rendered that row under the
 * always-filled policy it gains the missing slots and becomes clearable.
 */
function isManagedParams(parts: string[]): boolean {
  if (isOrientationWord(parts[0])) return true;
  let numerics = 0;
  for (const part of parts) if (NUMERIC.test(part)) numerics += 1;
  return numerics >= 2;
}

/** The managed test over a whole line, for callers that hold the raw text. */
export function isManagedLine(raw: string): boolean {
  const parts = parseEmbedParams(raw);
  return parts !== null && isManagedParams(parts);
}

/** Drop the leading word params, keeping every numeric one.  Used for a
 *  reference DIAA never hosted: its alignment word is DIAA's, its numbers are
 *  Obsidian's (`文字 ![[a.png|center|400]] 文字` → `文字 ![[a.png|400]] 文字`). */
function stripLeadingWords(params: string): string {
  const parts = params.split("|");
  let i = 0;
  while (i < parts.length && (isOrientationWord(parts[i]) || isAlignmentWord(parts[i]))) i += 1;
  return parts.slice(i).join("|");
}

/** Rewrite the references embedded in a line that isn't an image row, or null
 *  when none of them carries anything DIAA wrote. */
function clearInline(line: string, embedRe: RegExp): string | null {
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of line.matchAll(embedRe)) {
    const params = match[2];
    if (params === undefined) continue;
    const kept = isManagedParams(params.split("|")) ? "" : stripLeadingWords(params);
    if (kept === params) continue;
    const from = match.index ?? 0;
    pieces.push(line.slice(cursor, from), `![[${match[1]}${kept ? `|${kept}` : ""}]]`);
    cursor = from + match[0].length;
  }
  if (pieces.length === 0) return null;
  pieces.push(line.slice(cursor));
  return pieces.join("");
}

/** Strip what DIAA wrote off every image reference in the file. */
export const clearPlan: LinePlan = (lines, extensions) => {
  const rowRe = buildImageLineRe(extensions);
  const embedRe = buildImageEmbedRe(extensions);
  const out = new Map<number, string>();
  for (const [i, line] of lines.entries()) {
    const next = rowRe.test(line)
      ? (isManagedLine(line) ? stripEmbedParams(line) : null)
      : clearInline(line, embedRe);
    if (next !== null && next !== line) out.set(i, next);
  }
  return out;
};
