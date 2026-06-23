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
  const widthStr = match[2];
  const explicitWidth = widthStr ? parseInt(widthStr, 10) : null;

  return {
    line: lineIndex,
    raw: line,
    fileName,
    explicitWidth,
    hasExplicitWidth: explicitWidth !== null,
    flexGrow: explicitWidth ? explicitWidth / 100 : 1,
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
