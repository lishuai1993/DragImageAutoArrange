import { buildImageLineRe } from "../constants";
import { read } from "./rowParams";
import type { RowImage, RowKind } from "./rowParams";

export interface ImageMeta {
  naturalWidth: number;
  naturalHeight: number;
}

// ── Typed classifier (rowParams model) ──────────────────────────────────
// Detection over the new self-describing model: a run of consecutive image
// lines is chunked by maxImagesPerRow, then each chunk is parsed ONCE with the
// kind it actually is (multi for ≥2 members, single for 1).  A lone leftover
// member of a split former row is classified as a single row here — its display
// kind then follows the single grammar.

export interface RowGroup {
  lineStart: number;
  lineEnd: number;
  kind: RowKind;
  images: RowImage[];
}

export function detectRowGroups(
  text: string,
  maxImagesPerRow: number,
  extensions: string
): RowGroup[] {
  const re = buildImageLineRe(extensions);
  const lines = text.split("\n");
  const groups: RowGroup[] = [];
  let run: Array<{ index: number; text: string }> = [];

  const flush = () => {
    if (run.length === 0) return;
    for (let i = 0; i < run.length; i += maxImagesPerRow) {
      const chunk = run.slice(i, i + maxImagesPerRow);
      const kind: RowKind = chunk.length === 1 ? "single" : "multi";
      const chunkText = chunk.map((c) => c.text).join("\n");
      groups.push({
        lineStart: chunk[0].index,
        lineEnd: chunk[chunk.length - 1].index + 1,
        kind,
        images: read(chunkText, kind, extensions, chunk[0].index),
      });
    }
    run = [];
  };

  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      run.push({ index: i, text: lines[i] });
    } else {
      flush();
    }
  }
  flush();

  return groups;
}
