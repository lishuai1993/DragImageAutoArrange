import { buildImageLineRe } from "./constants";
import { logger } from "./logger";

export interface ImageEmbed {
  line: number;
  raw: string;
  fileName: string;
  explicitWidth: number | null;
  /** flex-grow from |width in markdown (true) vs computed from aspect ratio (false) */
  hasExplicitWidth: boolean;
  flexGrow: number;
  /** image-content-width / item-width ratio, persisted as second |param in markdown.
   *  null means default (image fills item naturally, no resize applied). */
  scale: number | null;
  /** Per-image alignment.  When absent the row-level global alignment applies.
   *  Persisted as the first pipe param: ![[file|left|120|50]]. */
  alignment?: "left" | "center" | "right";
}

export interface ImageGroup {
  lineStart: number;
  lineEnd: number;
  images: ImageEmbed[];
}

export interface ImageMeta {
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Parse a single image embed line.
 * Returns parsed info or null if the line doesn't match.
 */
export function parseImageLine(
  line: string,
  lineIndex: number,
  re: RegExp
): ImageEmbed | null {
  const match = line.match(re);
  if (!match) return null;

  const fileName = match[1];
  const rawParam = match[2];

  // Per-image alignment — always the first param when present.
  // Format: ![[file|left|120|50]] (multi) or ![[file|center|0|350]] (single).
  const alignMatch = rawParam ? rawParam.match(/^(left|center|right)\|/) : null;
  const alignment = alignMatch
    ? (alignMatch[1] as "left" | "center" | "right")
    : undefined;

  // First numeric param — skip a leading alignment word if present.
  const firstNum = rawParam ? rawParam.match(/(?:^|\|)(\d+)/) : null;
  const explicitWidth = firstNum ? parseInt(firstNum[1], 10) : null;

  // Second numeric param (scale) — always the last |digits in the string.
  // When there's only one numeric in rawParam, firstNum and scaleMatch will
  // both match the same occurrence.  Don't double-assign — leave scale null
  // so the layout backfill can fill it from rendered state.
  const scaleMatch = rawParam ? rawParam.match(/\|(\d+)$/) : null;
  const sameOccurrence = firstNum && scaleMatch && firstNum.index === scaleMatch.index;
  const scale = (scaleMatch && !sameOccurrence) ? parseInt(scaleMatch[1], 10) / 100 : null;

  return {
    line: lineIndex,
    raw: line,
    fileName,
    explicitWidth,
    hasExplicitWidth: explicitWidth !== null,
    flexGrow: explicitWidth ? explicitWidth / 100 : 1,
    scale,
    alignment,
  };
}

/**
 * Detect consecutive image embed lines in markdown text.
 * Returns an array of ImageGroups ordered by line position.
 */
export function detectImageGroups(
  text: string,
  maxImagesPerRow: number,
  extensions: string
): ImageGroup[] {
  const re = buildImageLineRe(extensions);
  const lines = text.split("\n");
  const groups: ImageGroup[] = [];
  let currentGroup: ImageEmbed[] = [];

  logger.debug("detectImageGroups start", {
    lineCount: lines.length,
    maxImagesPerRow,
    extensions,
  });

  const flushGroup = () => {
    if (currentGroup.length === 0) return;
    // Split oversized groups
    for (let i = 0; i < currentGroup.length; i += maxImagesPerRow) {
      const chunk = currentGroup.slice(i, i + maxImagesPerRow);
      groups.push({
        lineStart: chunk[0].line,
        lineEnd: chunk[chunk.length - 1].line + 1,
        images: [...chunk],
      });
    }
    currentGroup = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseImageLine(lines[i], i, re);
    if (parsed) {
      currentGroup.push(parsed);
    } else {
      flushGroup();
    }
  }
  flushGroup();

  logger.debug("detectImageGroups result", {
    groupCount: groups.length,
    groups: groups.map((g) => ({
      lineStart: g.lineStart,
      lineEnd: g.lineEnd,
      imageCount: g.images.length,
      files: g.images.map((img) => img.fileName),
    })),
  });

  return groups;
}

/**
 * Check if a single line is an image embed line.
 */
export function isImageLine(
  line: string,
  extensions: string
): boolean {
  return buildImageLineRe(extensions).test(line);
}
