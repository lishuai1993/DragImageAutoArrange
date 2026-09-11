import { type App, type TFile } from 'obsidian';
import { markdownCodeRanges, overlapsRange } from './markdownRanges';

/** 匹配 Obsidian 的 wiki 图像链接：`![[图.png]]`。 */
const WIKILINK_IMAGE_REGEX = /!\[\[([^\]]+)\]\]/g;

/**
 * Markdown 中图像链接的扫描与改写。
 *
 * 只处理图像引用本身：wiki 形式 `![[图.png|100]]` 与 markdown 形式
 * `![alt|100](图.png)`，两种形式都跳过代码块与行内代码（那里的 `![[..]]`
 * 是示例文本，不是嵌入）。求值一律走 `resolveLink`，因此「这个链接指向哪张
 * 图」与链接写法无关。
 */

/** 一条解析后的图像链接：路径 / 锚点 / 参数 / 是哪种写法。 */
export interface ImageLink {
  path: string;
  hash: string;
  params: string[];
  isWikiStyle: boolean;
}

interface MarkdownLinkMatch {
  start: number;
  end: number;
  fullMatch: string;
  description: string;
  linkPath: string;
  titleSuffix: string;
  rawDestination: string;
}

/**
 * 0-based 源码行号定位用不了 `\n` 之外的分隔符，这里按 `\n` 计数。
 */
function countNewlines(value: string): number {
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 10) count += 1;
  }
  return count;
}

/** `decodeURIComponent` 的容错版：解不开就原样返回。 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 解析 Obsidian 的尺寸参数，支持 `300` / `300x200` / `300px`。 */
export function parseObsidianImageSizeParam(value: string): { width: number; height?: number } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const sizeMatch = trimmed.match(/^([1-9]\d*)(?:x([1-9]\d*))?(?:px)?$/i);
  if (!sizeMatch) return null;

  const width = Number.parseInt(sizeMatch[1], 10);
  if (!Number.isFinite(width) || width <= 0) return null;

  const heightRaw = sizeMatch[2];
  if (!heightRaw) return { width };

  const height = Number.parseInt(heightRaw, 10);
  if (!Number.isFinite(height) || height <= 0) return { width };

  return { width, height };
}

/**
 * 从参数列表里取最后一条尺寸参数（Obsidian 允许 `|100|left` 这类多参数，
 * 尺寸可能不在首位）。
 */
export function findLastObsidianImageSizeParam(
  values: string[]
): { index: number; width: number; height?: number } | null {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const parsed = parseObsidianImageSizeParam(values[index]);
    if (parsed) return { index, ...parsed };
  }
  return null;
}

/** 把链接路径解析为库内文件；给了 `imageFile` 则要求解析结果就是它。 */
export function resolveLink(app: App, linkPath: string, activeFile: TFile, imageFile?: TFile): TFile | null {
  const resolvedFile = app.metadataCache.getFirstLinkpathDest(linkPath, activeFile.path);
  if (!resolvedFile) return null;
  if (imageFile && resolvedFile.path !== imageFile.path) return null;
  return resolvedFile;
}

function scanMarkdownImageLinks(text: string, onMatch: (match: MarkdownLinkMatch) => void): void {
  // 被渲染成代码的链接是语法示例而不是嵌入，绝不能改写。
  const codeRanges = markdownCodeRanges(text);
  let index = 0;
  const length = text.length;

  while (index < length) {
    const start = text.indexOf('![', index);
    if (start === -1) break;

    // alt 文本：![ ... ](...)
    let cursor = start + 2;
    let altEnd = -1;
    while (cursor < length) {
      const char = text[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === ']') {
        altEnd = cursor;
        break;
      }
      cursor += 1;
    }

    if (altEnd === -1 || text[altEnd + 1] !== '(') {
      index = start + 1;
      continue;
    }

    const description = text.substring(start + 2, altEnd);

    // 目标部分按括号配平扫描，URL 里允许出现括号。
    const destStartParen = altEnd + 1;
    let depth = 0;
    let destEndParen = -1;
    cursor = destStartParen;

    while (cursor < length) {
      const char = text[cursor];
      if (char === '\\') {
        cursor += 2;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          destEndParen = cursor;
          break;
        }
      }
      cursor += 1;
    }

    if (destEndParen === -1) break;

    const rawDestination = text.substring(destStartParen + 1, destEndParen);
    const { url, titleSuffix } = splitMarkdownLinkDestination(rawDestination);
    const fullMatch = text.substring(start, destEndParen + 1);

    if (!overlapsRange(codeRanges, start, destEndParen + 1)) {
      onMatch({
        start,
        end: destEndParen + 1,
        fullMatch,
        description,
        linkPath: url,
        titleSuffix,
        rawDestination,
      });
    }

    index = destEndParen + 1;
  }
}

/** 拆开 markdown 链接目标里的 URL 与尾随 title，支持尖括号包裹写法。 */
function splitMarkdownLinkDestination(destination: string): { url: string; titleSuffix: string } {
  const raw = destination;
  let cursor = 0;

  while (cursor < raw.length && /\s/.test(raw[cursor])) cursor += 1;
  if (cursor >= raw.length) return { url: '', titleSuffix: '' };

  if (raw[cursor] === '<') {
    let end = cursor + 1;
    while (end < raw.length) {
      const char = raw[end];
      if (char === '\\') {
        end += 2;
        continue;
      }
      if (char === '>') break;
      end += 1;
    }

    if (end < raw.length && raw[end] === '>') {
      return { url: raw.substring(cursor + 1, end).trim(), titleSuffix: raw.substring(end + 1) };
    }
  }

  const urlStart = cursor;
  while (cursor < raw.length) {
    const char = raw[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    cursor += 1;
  }

  return { url: raw.substring(urlStart, cursor).trim(), titleSuffix: raw.substring(cursor) };
}

function encodeMarkdownPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function replaceMarkdownImageLinks(
  text: string,
  replacer: (match: MarkdownLinkMatch) => string
): string {
  let result = '';
  let lastIndex = 0;

  scanMarkdownImageLinks(text, match => {
    result += text.substring(lastIndex, match.start);
    result += replacer(match);
    lastIndex = match.end;
  });

  result += text.substring(lastIndex);
  return result;
}

/** wiki 形式的替换，同样跳过代码块与行内代码。 */
function replaceWikiImageLinks(
  text: string,
  replacer: (match: string, linkInner: string, offset: number) => string
): string {
  const codeRanges = markdownCodeRanges(text);
  return text.replace(WIKILINK_IMAGE_REGEX, (match: string, linkInner: string, offset: number) => {
    if (overlapsRange(codeRanges, offset, offset + match.length)) return match;
    return replacer(match, linkInner, offset);
  });
}

/**
 * 拆出 frontmatter 与正文。只在文件以 `---` 开头且能找到收尾 `---` 时才认作
 * frontmatter；缺收尾符则整体当正文。
 */
function splitFrontmatter(data: string): { frontmatter: string; content: string } {
  const match = data.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!match) return { frontmatter: '', content: data };
  const frontmatter = match[0];
  return { frontmatter, content: data.substring(frontmatter.length) };
}

/**
 * 把一段文本里的目标图像链接按 `transform` 改写参数，wiki 与 markdown 形式
 * 都处理。
 */
export function updateLinks(
  app: App,
  text: string,
  activeFile: TFile,
  imageFile: TFile,
  transform: (params: string[]) => string[]
): string {
  const afterWiki = replaceWikiImageLinks(text, (match: string, linkInner: string) => {
    const link = parseLinkComponents(linkInner);
    if (!resolveLink(app, link.path, activeFile, imageFile)) return match;
    link.params = transform(link.params);
    return `![[${buildLinkPath(link)}]]`;
  });

  return replaceMarkdownImageLinks(afterWiki, ({ fullMatch, description, linkPath, titleSuffix }) => {
    const link = parseLinkComponents(description, linkPath);
    if (!resolveLink(app, link.path, activeFile, imageFile)) return fullMatch;

    const baseDesc = description.split('|')[0].trim();
    const desc = baseDesc || imageFile.basename;
    link.params = transform(link.params);
    const newDescription = link.params.length > 0 ? [desc, ...link.params].join('|') : desc;
    // markdown 形式把参数留在 alt 里，URL 本身保持干净；路径需要转义空格等字符。
    const newDestination = `${buildLinkPath({ ...link, params: [] }, true)}${titleSuffix}`;
    return `![${newDescription}](${newDestination})`;
  });
}

function normalizeUrlForComparison(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

/** 两个外部 URL 是否指向同一地址（忽略 URL 规范化差异）。 */
export function isSameExternalUrl(a: string, b: string): boolean {
  return normalizeUrlForComparison(a) === normalizeUrlForComparison(b);
}

function updateExternalLinks(
  text: string,
  imageUrl: string,
  transform: (params: string[]) => string[]
): string {
  return replaceMarkdownImageLinks(text, ({ fullMatch, description, linkPath, rawDestination }) => {
    if (!isSameExternalUrl(linkPath, imageUrl)) return fullMatch;

    const [baseDescRaw, ...params] = description.split('|');
    const baseDesc = baseDescRaw.trim();
    const newParams = transform(params);
    const newDescription = newParams.length > 0 ? [baseDesc, ...newParams].join('|') : baseDesc;
    return `![${newDescription}](${rawDestination})`;
  });
}

/**
 * 解析一条图像链接。
 *
 * wiki 形式 `![[图.png|100#标题]]`：参数来自 `|` 分段，锚点要么跟着路径
 * （`图.png#标题|100`），要么挂在最后一个参数尾部（`图.png|100#标题`）。
 * markdown 形式 `![alt|100](图.png#标题)`：参数来自 alt，锚点来自 URL。
 */
export function parseLinkComponents(mainPart: string, linkPath?: string): ImageLink {
  if (linkPath) {
    // 先切锚点再解码，保证文件名里的 %23 仍是字面 `#`。
    const [rawPathWithoutHash, rawHash] = linkPath.split('#', 2);
    const hash = rawHash ? `#${rawHash}` : '';
    const path = safeDecodeURIComponent(rawPathWithoutHash);
    const [, ...params] = mainPart.split('|');
    return { path, hash, params, isWikiStyle: false };
  }

  const [pathAndMaybeHash, ...rawParams] = mainPart.split('|');
  let path = pathAndMaybeHash;
  let hash = '';
  const hashIndex = pathAndMaybeHash.indexOf('#');
  if (hashIndex >= 0) {
    path = pathAndMaybeHash.substring(0, hashIndex);
    hash = pathAndMaybeHash.substring(hashIndex);
  } else if (rawParams.length > 0) {
    const lastParam = rawParams[rawParams.length - 1];
    const lastHashIndex = lastParam.indexOf('#');
    if (lastHashIndex >= 0) {
      const paramPrefix = lastParam.substring(0, lastHashIndex);
      const hashSuffix = lastParam.substring(lastHashIndex);
      // 只有当 `#` 之前那段看起来像尺寸参数时，才认定它是锚点。
      if (/^[1-9]\d*(?:x[1-9]\d*)?(?:px)?$/i.test(paramPrefix)) {
        rawParams[rawParams.length - 1] = paramPrefix;
        hash = hashSuffix;
      }
    }
  }

  return { path, hash, params: rawParams, isWikiStyle: true };
}

/** 把解析结果拼回链接：路径 + `|参数` + 锚点。 */
export function buildLinkPath(link: ImageLink, encode = false): string {
  const paramsStr = link.params.length > 0 ? `|${link.params.join('|')}` : '';

  let finalPath = link.path;
  if (encode) {
    finalPath = link.path
      .split('/')
      .map(segment => encodeMarkdownPathSegment(segment))
      .join('/');
  }

  return `${finalPath}${paramsStr}${link.hash}`;
}

/**
 * 把整篇文档里的目标图像链接按 `transform` 改写参数并落盘。
 * 解析与替换都在 `vault.process` 内完成，避免覆盖并发编辑。
 */
export async function updateImageLinks(
  app: App,
  activeFile: TFile,
  imageFile: TFile,
  transform: (params: string[]) => string[]
): Promise<boolean> {
  if (activeFile.path === imageFile.path) return false;

  let didChange = false;

  await app.vault.process(activeFile, data => {
    const { frontmatter, content } = splitFrontmatter(data);
    const replacedText = updateLinks(app, content, activeFile, imageFile, transform);
    if (replacedText === content) return data;

    didChange = true;
    return frontmatter ? `${frontmatter}${replacedText}` : replacedText;
  });

  return didChange;
}

/** 同上，但按 URL 匹配外部（http/https）图像链接，只处理 markdown 形式。 */
export async function updateExternalImageLinks(
  app: App,
  activeFile: TFile,
  imageUrl: string,
  transform: (params: string[]) => string[]
): Promise<boolean> {
  let didChange = false;

  await app.vault.process(activeFile, data => {
    const { frontmatter, content } = splitFrontmatter(data);
    const replacedText = updateExternalLinks(content, imageUrl, transform);
    if (replacedText === content) return data;

    didChange = true;
    return frontmatter ? `${frontmatter}${replacedText}` : replacedText;
  });

  return didChange;
}

/** 在给定文本里找目标图像的当前宽度覆盖值（`|100` 里的 100），没有则 null。 */
export function findCurrentImageWidthInText(
  app: App,
  activeFile: TFile,
  imageFile: TFile,
  text: string
): number | null {
  const codeRanges = markdownCodeRanges(text);
  for (const match of text.matchAll(WIKILINK_IMAGE_REGEX)) {
    if (overlapsRange(codeRanges, match.index ?? 0, (match.index ?? 0) + match[0].length)) continue;
    const link = parseLinkComponents(match[1]);
    if (!resolveLink(app, link.path, activeFile, imageFile)) continue;
    const sizeParam = findLastObsidianImageSizeParam(link.params);
    if (sizeParam) return sizeParam.width;
  }

  let foundWidth: number | null = null;
  scanMarkdownImageLinks(text, ({ description, linkPath }) => {
    if (foundWidth !== null) return;
    const link = parseLinkComponents(description, linkPath);
    if (!resolveLink(app, link.path, activeFile, imageFile)) return;
    const sizeParam = findLastObsidianImageSizeParam(link.params);
    if (sizeParam) foundWidth = sizeParam.width;
  });

  return foundWidth;
}

/** 同上，按 URL 匹配外部图像。 */
export function findCurrentExternalImageWidthInText(imageUrl: string, text: string): number | null {
  let foundWidth: number | null = null;

  scanMarkdownImageLinks(text, ({ description, linkPath }) => {
    if (foundWidth !== null) return;
    if (!isSameExternalUrl(linkPath, imageUrl)) return;
    const [, ...params] = description.split('|');
    const sizeParam = findLastObsidianImageSizeParam(params);
    if (sizeParam) foundWidth = sizeParam.width;
  });

  return foundWidth;
}

/** 清掉当前笔记中指向该图像的全部链接（供「删除图像和链接」用）。 */
export async function removeImageLinks(app: App, activeFile: TFile, imageFile: TFile): Promise<boolean> {
  if (activeFile.path === imageFile.path) return false;

  let didChange = false;

  await app.vault.process(activeFile, data => {
    const { frontmatter, content } = splitFrontmatter(data);

    let replacedText = replaceWikiImageLinks(content, (match: string, linkInner: string) => {
      const link = parseLinkComponents(linkInner);
      return resolveLink(app, link.path, activeFile, imageFile) ? '' : match;
    });

    replacedText = replaceMarkdownImageLinks(replacedText, ({ fullMatch, description, linkPath }) => {
      const link = parseLinkComponents(description, linkPath);
      return resolveLink(app, link.path, activeFile, imageFile) ? '' : fullMatch;
    });

    if (replacedText === content) return data;

    didChange = true;
    return frontmatter ? `${frontmatter}${replacedText}` : replacedText;
  });

  return didChange;
}

export interface RemovalOptions {
  /** 最多移除几处引用，默认 1。 */
  max?: number;
  /** 限定在某个 0-based 源码行，null 表示不限。 */
  line?: number | null;
  /** 移除后对正文再做一次整理，参数是整理后的正文与首个移除点所在行。 */
  afterRemoval?: (content: string, removedLine: number | null) => string;
}

/**
 * {@link removeImageLinkOccurrences} 的纯函数内核：给定文档全文，返回改写后的
 * 文本与命中/移除计数，不写盘。拆出来是为了让持有 live editor 的调用方能以
 * CodeMirror 事务施加结果——可撤销、且视口不动——而不是绕道 vault 往返。
 */
export function planImageLinkRemoval(
  app: App,
  fullText: string,
  imageFile: TFile,
  activeFile: TFile,
  opts: RemovalOptions = {}
): { next: string; found: number; removed: number } {
  const max = opts.max ?? 1;
  const onlyLine = opts.line ?? null;
  const { frontmatter, content } = splitFrontmatter(fullText);
  const baseLine = countNewlines(frontmatter);

  let found = 0;
  let removed = 0;
  let removedLine: number | null = null;

  const take = (match: string, line: number): string => {
    found += 1;
    if (removed >= max) return match;
    if (onlyLine !== null && line !== onlyLine) return match;
    removed += 1;
    if (removedLine === null) removedLine = line;
    return '';
  };

  let next = replaceWikiImageLinks(content, (match: string, linkInner: string, offset: number) => {
    const link = parseLinkComponents(linkInner);
    if (!resolveLink(app, link.path, activeFile, imageFile)) return match;
    return take(match, baseLine + countNewlines(content.slice(0, offset)));
  });

  // markdown 这一趟扫的是 wiki 那趟的输出，所以位移是相对它量的。
  const mdPassText = next;
  next = replaceMarkdownImageLinks(
    mdPassText,
    ({ fullMatch, description, linkPath, start }) => {
      const link = parseLinkComponents(description, linkPath);
      if (!resolveLink(app, link.path, activeFile, imageFile)) return fullMatch;
      return take(fullMatch, baseLine + countNewlines(mdPassText.slice(0, start)));
    }
  );

  if (opts.afterRemoval) {
    next = opts.afterRemoval(next, removedLine === null ? null : removedLine - baseLine);
  }

  if (next === content) return { next: fullText, found, removed };
  return { next: frontmatter ? `${frontmatter}${next}` : next, found, removed };
}

/**
 * 从当前笔记中移除至多 `max` 处指向该图像的引用，可限定在某一行，通过写盘
 * 完成。持有打开中编辑器的调用方应优先用 {@link planImageLinkRemoval}，改动
 * 才可撤销、视口才不跳；这里是没有编辑器可用的兜底。
 *
 * {@link removeImageLinks} 是有意一次清空全部引用（对应「删除图像和链接」），
 * 这个变体则服务于「只丢一处引用」——把一张图从多图行里剪出去——多删就是误伤。
 */
export async function removeImageLinkOccurrences(
  app: App,
  imageFile: TFile,
  opts: RemovalOptions = {}
): Promise<{ found: number; removed: number }> {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile || activeFile.path === imageFile.path) return { found: 0, removed: 0 };

  let result = { found: 0, removed: 0 };

  await app.vault.process(activeFile, data => {
    const planned = planImageLinkRemoval(app, data, imageFile, activeFile, opts);
    result = { found: planned.found, removed: planned.removed };
    return planned.next;
  });

  return result;
}
