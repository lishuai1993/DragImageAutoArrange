// ── Embed ↔ parsed-param matching (pure, unit-tested) ────────────────
// Kept free of DOM/Obsidian dependencies so CI can guard the invariants
// that readingMode.ts relies on. Callers pass plain filenames + parsed
// records (any object carrying a fileName — today RowImage); this module owns
// the matching policy and its integrity check, touching nothing but fileName.

export interface MatchResult<T extends { fileName: string }> {
  /** Aligned 1:1 with the input embedFileNames array. null = no match. */
  matches: (T | null)[];
  /** Count of embeds whose known filename disagrees with the assigned parse. */
  mismatches: number;
  /** True when section-scoped matching failed its integrity check and the
   *  filename-only global fallback was used instead. */
  usedFallback: boolean;
}

/** Count embeds whose (non-empty) filename disagrees with their assigned
 *  parse. Null filenames are unverifiable (img src not yet readable) and are
 *  never counted as a mismatch. */
function countMismatches<T extends { fileName: string }>(
  embedFileNames: (string | null)[],
  matches: (T | null)[]
): number {
  let n = 0;
  for (let i = 0; i < embedFileNames.length; i++) {
    const fn = embedFileNames[i];
    if (!fn) continue;
    const m = matches[i];
    if (!m || m.fileName !== fn) n++;
  }
  return n;
}

/** Filename-primary match within an ordered candidate list.
 *  - Known filename: seek forward from the cursor for the next candidate with
 *    that filename (position disambiguates duplicates, source order preserved).
 *  - Unknown filename (null): take the candidate at the positional cursor. */
function matchWithin<T extends { fileName: string }>(
  embedFileNames: (string | null)[],
  candidates: T[]
): (T | null)[] {
  const out: (T | null)[] = [];
  let cursor = 0;
  for (const fn of embedFileNames) {
    if (fn) {
      let k = cursor;
      while (k < candidates.length && candidates[k].fileName !== fn) k++;
      if (k < candidates.length) {
        out.push(candidates[k]);
        cursor = k + 1;
      } else {
        out.push(null);
      }
    } else {
      out.push(cursor < candidates.length ? candidates[cursor] : null);
      cursor++;
    }
  }
  return out;
}

/** Filename-only global match, ignoring source line/position — the degrade
 *  path when section-scoped matching fails its integrity check. */
function matchByFilenameOnly<T extends { fileName: string }>(
  embedFileNames: (string | null)[],
  allParsed: T[]
): (T | null)[] {
  const out: (T | null)[] = [];
  let cursor = 0;
  for (const fn of embedFileNames) {
    if (!fn) {
      out.push(null);
      continue;
    }
    let k = cursor;
    while (k < allParsed.length && allParsed[k].fileName !== fn) k++;
    if (k < allParsed.length) {
      out.push(allParsed[k]);
      cursor = k + 1;
    } else {
      out.push(null);
    }
  }
  return out;
}

/** Match a section's image embeds to parsed markdown params.
 *
 *  Primary: filename-primary matching within `candidates` (the parsed records
 *  scoped to this section's source line range). If an integrity check detects
 *  any filename mismatch, it degrades to a filename-only global match against
 *  `allParsed` and flags `usedFallback` so the caller can surface a warning. */
export function matchEmbedsToParsed<T extends { fileName: string }>(
  embedFileNames: (string | null)[],
  candidates: T[],
  allParsed: T[]
): MatchResult<T> {
  const primary = matchWithin(embedFileNames, candidates);
  const mismatches = countMismatches(embedFileNames, primary);
  if (mismatches === 0) {
    return { matches: primary, mismatches: 0, usedFallback: false };
  }
  const fallback = matchByFilenameOnly(embedFileNames, allParsed);
  return {
    matches: fallback,
    mismatches: countMismatches(embedFileNames, fallback),
    usedFallback: true,
  };
}
