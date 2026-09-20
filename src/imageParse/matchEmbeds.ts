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

/** The last path segment of an embed's target.
 *
 *  The two sides of a comparison name the same file differently: the parser
 *  keeps the link verbatim, folder included (`![[图片集/a.png]]` →
 *  `图片集/a.png`), while the DOM reader can only see `img.src` and takes its
 *  last segment (`a.png`).  Comparing the raw strings makes every subfolder link
 *  disagree with its own line. */
export function basename(name: string): string {
  const cut = name.lastIndexOf("/");
  return cut === -1 ? name : name.slice(cut + 1);
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
    if (!m || basename(m.fileName) !== basename(fn)) n++;
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
      const want = basename(fn);
      let k = cursor;
      while (k < candidates.length && basename(candidates[k].fileName) !== want) k++;
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

/** Filename-only match, ignoring source line/position — the degrade path when
 *  section-scoped matching fails its integrity check. */
function matchByFilenameOnly<T extends { fileName: string }>(
  embedFileNames: (string | null)[],
  pool: T[]
): (T | null)[] {
  const out: (T | null)[] = [];
  let cursor = 0;
  for (const fn of embedFileNames) {
    if (!fn) {
      out.push(null);
      continue;
    }
    const want = basename(fn);
    let k = cursor;
    while (k < pool.length && basename(pool[k].fileName) !== want) k++;
    if (k < pool.length) {
      out.push(pool[k]);
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
 *  any filename mismatch, it degrades to a filename-only match and flags
 *  `usedFallback` so the caller can surface a warning.
 *
 *  The degrade path prefers the section's own candidates and only widens to the
 *  whole document when that pool does no better: a bare-name hunt over the
 *  document takes the *first* same-named line, which for a duplicated attachment
 *  is a different row entirely — the section's params then get attributed to the
 *  wrong embed (its grow, fill and rotate all land on somebody else's picture).
 */
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
  const withinSection = matchByFilenameOnly(embedFileNames, candidates);
  const global = matchByFilenameOnly(embedFileNames, allParsed);
  const fallback =
    countMismatches(embedFileNames, withinSection) <= countMismatches(embedFileNames, global)
      ? withinSection
      : global;
  return {
    matches: fallback,
    mismatches: countMismatches(embedFileNames, fallback),
    usedFallback: true,
  };
}
