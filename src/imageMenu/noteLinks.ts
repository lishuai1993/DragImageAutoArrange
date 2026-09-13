/**
 * Locating and dropping references to one image inside a note's markdown.
 *
 * Everything here works on text, so it is independent of which editor (or mode)
 * the note is displayed in: the caller hands in the current content and gets
 * back the rewritten content plus counts. The one exception,
 * `removeImageLinkOccurrences`, reads and writes the note through the vault, for
 * the case where no editor is available.
 *
 * Two conventions matter for the callers:
 *
 * - Fenced code blocks are never touched. A link-looking string inside ``` or
 *   ~~~ is an example, not a reference.
 * - Frontmatter is excluded from line numbering. The line a caller passes in is
 *   an absolute 0-based source line (frontmatter included, which is what the DOM
 *   anchors report), while the line handed back through `afterRemoval` is
 *   relative to the body — the same coordinate space as the content that
 *   callback receives.
 */

import type { App, TFile } from 'obsidian';
import { logger } from '../logger';

const log = logger.channel('noteLinks');

export interface LinkRemovalOptions {
    /** How many references to remove at most (default 1). */
    max?: number;
    /** Absolute 0-based source line to restrict the removal to. */
    line?: number | null;
    /**
     * Rewrites the content after the link text was blanked. Receives the removed
     * line (relative to the body, i.e. frontmatter excluded) so the callback can
     * tidy up the row that just lost a member.
     */
    afterRemoval?: (content: string, removedLine: number | null) => string;
}

export interface LinkRemovalPlan {
    /** The note content with the reference(s) removed. */
    next: string;
    /** References to this image found in the note. */
    found: number;
    /** References actually removed. */
    removed: number;
}

/** Wiki embed `![[file#sub|params]]` or markdown image `![alt](file "title")`. */
const IMAGE_LINK_RE =
    /!\[\[([^[\]|#]+)(?:#[^[\]|]*)?(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;

interface Occurrence {
    line: number;
    start: number;
    end: number;
}

interface FrontmatterSplit {
    /** The frontmatter block including its trailing newline ('' when absent). */
    frontmatter: string;
    /** Everything after the frontmatter. */
    body: string;
    /** Lines the frontmatter occupies. */
    fmLines: number;
}

/** Split off a leading YAML frontmatter block so it can be excluded from line numbering. */
function splitFrontmatter(content: string): FrontmatterSplit {
    const lines = content.split('\n');
    if (lines[0]?.trim() !== '---') return { frontmatter: '', body: content, fmLines: 0 };

    for (let i = 1; i < lines.length; i += 1) {
        const trimmed = lines[i].trim();
        if (trimmed !== '---' && trimmed !== '...') continue;
        const fmLines = i + 1;
        return {
            frontmatter: `${lines.slice(0, fmLines).join('\n')}\n`,
            body: lines.slice(fmLines).join('\n'),
            fmLines,
        };
    }
    return { frontmatter: '', body: content, fmLines: 0 };
}

/** Marks the lines that sit inside a fenced code block (including the fences). */
function fencedLines(lines: string[]): boolean[] {
    const flags: boolean[] = [];
    let openFence: string | null = null;

    for (const line of lines) {
        const match = /^(`{3,}|~{3,})/.exec(line.trimStart());
        if (openFence === null) {
            flags.push(false);
            if (match) openFence = match[1];
        } else {
            flags.push(true);
            if (match && match[1][0] === openFence[0]) openFence = null;
        }
    }
    return flags;
}

/** Vault path a link target points at, or null when it cannot be resolved. */
function targetPath(app: App, target: string, sourcePath: string): string | null {
    const withoutFragment = target.split('#')[0];
    if (!withoutFragment) return null;
    let decoded = withoutFragment;
    try {
        decoded = decodeURIComponent(withoutFragment);
    } catch {
        // keep the raw form — a malformed escape is not a reason to skip the link
    }
    return app.metadataCache.getFirstLinkpathDest(decoded, sourcePath)?.path ?? null;
}

/** Every reference to `imgPath` in `lines`, in document order. */
function findOccurrences(
    app: App,
    lines: string[],
    imgPath: string,
    sourcePath: string
): Occurrence[] {
    const fenced = fencedLines(lines);
    const found: Occurrence[] = [];

    for (let i = 0; i < lines.length; i += 1) {
        if (fenced[i]) continue;
        const text = lines[i];
        IMAGE_LINK_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMAGE_LINK_RE.exec(text)) !== null) {
            const target = match[1] ?? match[2] ?? '';
            if (target && targetPath(app, target, sourcePath) === imgPath) {
                found.push({ line: i, start: match.index, end: match.index + match[0].length });
            }
        }
    }
    return found;
}

/** Blank out the given occurrences, right-to-left so offsets stay valid. */
function blankOccurrences(lines: string[], occurrences: Occurrence[]): string {
    const next = [...lines];
    const byLine = new Map<number, Occurrence[]>();
    for (const occurrence of occurrences) {
        const list = byLine.get(occurrence.line);
        if (list) list.push(occurrence);
        else byLine.set(occurrence.line, [occurrence]);
    }

    for (const [line, onLine] of byLine) {
        let text = next[line];
        for (const occurrence of [...onLine].sort((a, b) => b.start - a.start)) {
            text = text.slice(0, occurrence.start) + text.slice(occurrence.end);
        }
        next[line] = text;
    }
    return next.join('\n');
}

/**
 * Plan the removal of up to `max` references to `imgFile` from `content`,
 * preferring the line the user clicked when it is known. A removal blanks the
 * link text in place — leave a line empty and the caller's `afterRemoval` step
 * can drop it or normalise what is left of the row.
 */
export function planImageLinkRemoval(
    app: App,
    content: string,
    imgFile: TFile,
    noteFile: TFile,
    opts: LinkRemovalOptions = {}
): LinkRemovalPlan {
    const { frontmatter, body, fmLines } = splitFrontmatter(content);
    const lines = body.split('\n');
    const occurrences = findOccurrences(app, lines, imgFile.path, noteFile.path);
    const max = Math.max(0, opts.max ?? 1);
    const atLine = opts.line;
    const targets =
        atLine != null
            ? occurrences.filter(o => o.line === atLine - fmLines).slice(0, max)
            : occurrences.slice(0, max);

    if (targets.length === 0) return { next: content, found: occurrences.length, removed: 0 };

    let nextBody = blankOccurrences(lines, targets);
    if (opts.afterRemoval) nextBody = opts.afterRemoval(nextBody, targets[0].line);

    log.debug('LOG_LINK_REMOVAL', {
        img: imgFile.path,
        note: noteFile.path,
        found: occurrences.length,
        removed: targets.length,
        line: opts.line ?? null,
    });
    return { next: frontmatter + nextBody, found: occurrences.length, removed: targets.length };
}

/**
 * Removal without an editor to hand: read, rewrite and save the active note
 * through the vault. Not undoable and not scroll-stable, so callers prefer the
 * editor path whenever one exists. Does nothing when the active file *is* the
 * image, which would otherwise rewrite a binary as text.
 */
export async function removeImageLinkOccurrences(
    app: App,
    imgFile: TFile,
    opts: LinkRemovalOptions = {}
): Promise<{ found: number; removed: number }> {
    const note = app.workspace.getActiveFile();
    if (!note || note.path === imgFile.path) return { found: 0, removed: 0 };

    let found = 0;
    let removed = 0;
    await app.vault.process(note, content => {
        const planned = planImageLinkRemoval(app, content, imgFile, note, opts);
        found = planned.found;
        removed = planned.removed;
        return planned.next;
    });
    return { found, removed };
}
