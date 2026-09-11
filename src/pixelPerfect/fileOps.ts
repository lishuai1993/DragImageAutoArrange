import { Notice, type App, type TFile } from 'obsidian';
import { logger } from '../logger';
import { trashFile } from '../utils';
import { resolveLink, removeImageLinks, safeDecodeURIComponent } from './imageLinkOps';
import { NOTICE_DONE, NOTICE_FAILED } from './menuTexts';
import type { PixelPerfectImageSettings } from './ppSettingsModel';
import { DeleteImageConfirmModal, RenameImageModal } from './ppModals';

const log = logger.channel('fileOps');

/**
 * 把 DOM 里的 `<img>` 认回库内文件，以及围绕该文件的三项操作（在访达 /
 * 资源管理器中显示、用默认应用打开、重命名、删除图像和链接）。
 *
 * 认文件是整个右键菜单的地基：图是 Obsidian 渲染的，DOM 上只留下 `src` /
 * `alt` / 外层 embed 容器这几处线索，且各自的写法随引用形式（wiki / markdown、
 * 相对 / 绝对、带不带空格转义）而变。这里按线索可靠性从高到低依次尝试，
 * 命中唯一结果才认；一旦发现歧义（同名多文件、笔记内多个同名嵌入），宁可
 * 判为「找不到」也不猜。
 */

/** Obsidian 的 `App` 上未进类型定义、但长期存在的系统级文件操作。 */
interface AppWithSystemFileOps {
  showInFolder(path: string): void;
  openWithDefaultApp(path: string): void;
}

function getBaseName(value: string | null): string | null {
  if (!value) return null;
  const slashIdx = value.lastIndexOf('/');
  return slashIdx >= 0 ? value.substring(slashIdx + 1) : value;
}

function stripQueryAndHash(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? '';
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}

function looksLikeVaultFileName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /\.[a-zA-Z0-9]{2,8}$/.test(trimmed);
}

function getPathQualifiedLink(value: string | null): string | null {
  if (!value || !value.includes('/')) return null;
  return value;
}

/**
 * 把一处线索（`alt` 文本、`src`、容器属性）归一为候选链接：剥掉 `|参数`、
 * 查询串与哈希，再做 URL 解码；绝对本地路径与纯 URL（不允许时）直接判否。
 */
function normalizeLinkCandidate(value: string | null, allowUrlFallback: boolean): string | null {
  if (!value) return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const baseValue = trimmed.split('|')[0].trim();
  if (!baseValue) return null;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(baseValue)) {
    if (!allowUrlFallback) return null;
    const parsedFromUrl = parseFileNameFromSrc(baseValue);
    return parsedFromUrl?.includes('/') ? parsedFromUrl : null;
  }

  const withoutQueryOrHash = stripQueryAndHash(baseValue);
  if (!withoutQueryOrHash) return null;

  const decoded = safeDecodeURIComponent(withoutQueryOrHash);
  if (!decoded) return null;

  if (isAbsoluteLocalPath(decoded)) return null;

  return decoded;
}

/**
 * 从 `src` 里取出库内路径或文件名。Obsidian 常把整段库内路径编码进 URL 的
 * 最后一段，形如 `.../Images%2Fmy%20image.png`。
 */
function parseFileNameFromSrc(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;

  const withoutQueryOrHash = stripQueryAndHash(trimmed);
  if (!withoutQueryOrHash) return null;

  try {
    const url = new URL(withoutQueryOrHash);
    const lastSegment = url.pathname.split('/').filter(Boolean).pop();
    if (!lastSegment) return null;
    return safeDecodeURIComponent(lastSegment);
  } catch {
    const decoded = safeDecodeURIComponent(withoutQueryOrHash);

    if (!isAbsoluteLocalPath(decoded) && decoded.includes('/')) return decoded;

    const slashIdx = decoded.lastIndexOf('/');
    const fileName = slashIdx >= 0 ? decoded.substring(slashIdx + 1) : decoded;
    return fileName || null;
  }
}

/** 外层 embed 容器上的链接属性，逐项归一后取第一个可用的。 */
function getEmbedLinkPath(img: HTMLImageElement): string | null {
  const container = img.closest('.internal-embed, .image-embed, .image-container');
  const candidates = [
    container?.getAttribute('src') ?? null,
    container?.getAttribute('data-src') ?? null,
    container?.getAttribute('data-href') ?? null,
    container?.getAttribute('data-path') ?? null,
    container?.getAttribute('href') ?? null,
    img.getAttribute('src'),
    img.getAttribute('data-src'),
    img.getAttribute('data-href'),
    img.getAttribute('data-path'),
  ];

  for (const candidate of candidates) {
    const normalized = normalizeLinkCandidate(candidate, true);
    if (normalized) return normalized;
  }

  return null;
}

/** 在笔记自己的嵌入缓存里按文件名找图；同名多张时判为歧义。 */
function getFileFromNoteEmbedCache(
  app: App,
  activeFile: TFile,
  srcBaseName: string
): { file: TFile | null; ambiguous: boolean; cacheAvailable: boolean } {
  const cache = app.metadataCache.getFileCache(activeFile);
  if (!cache) return { file: null, ambiguous: false, cacheAvailable: false };

  const embeds = cache.embeds ?? [];
  let match: TFile | null = null;

  for (const embed of embeds) {
    const normalizedLink = normalizeLinkCandidate(embed.link, false);
    if (!normalizedLink) continue;
    if (getBaseName(normalizedLink) !== srcBaseName) continue;

    const resolvedFile = resolveLink(app, normalizedLink, activeFile);
    if (!resolvedFile) continue;

    if (match && match.path !== resolvedFile.path) {
      return { file: null, ambiguous: true, cacheAvailable: true };
    }
    match = resolvedFile;
  }

  return { file: match, ambiguous: false, cacheAvailable: true };
}

/** 全库按文件名找图；同名多张时判为歧义。 */
function getUniqueVaultFileByBaseName(app: App, baseName: string): { file: TFile | null; ambiguous: boolean } {
  let match: TFile | null = null;

  for (const file of app.vault.getFiles()) {
    if (file.name !== baseName) continue;
    if (match) return { file: null, ambiguous: true };
    match = file;
  }

  return { file: match, ambiguous: false };
}

function getFileFromBaseNameLink(
  app: App,
  value: string | null,
  activeFile: TFile,
  expectedBaseName: string | null
): TFile | null {
  if (!value || value.includes('/')) return null;
  if (!expectedBaseName) {
    if (!looksLikeVaultFileName(value)) return null;
  } else if (value !== expectedBaseName) {
    return null;
  }

  const resolvedFile = resolveLink(app, value, activeFile);
  if (!resolvedFile) return null;

  return !expectedBaseName || resolvedFile.name === expectedBaseName ? resolvedFile : null;
}

/** 把 `<img>` 认回库内文件；线索不足或有歧义时返回 null。 */
export function getFileForImage(app: App, img: HTMLImageElement, activeFile: TFile): TFile | null {
  const src = img.getAttribute('src') ?? '';
  const wikiLink = img.getAttribute('alt');
  const embedLinkPath = getEmbedLinkPath(img);
  const normalizedAltLink = normalizeLinkCandidate(wikiLink, false);
  const srcLinkPath = parseFileNameFromSrc(src);
  const basenameCandidate = getBaseName(srcLinkPath) ?? getBaseName(normalizedAltLink);

  if (embedLinkPath) {
    const fileFromEmbed = resolveLink(app, embedLinkPath, activeFile);
    if (fileFromEmbed) return fileFromEmbed;
  }

  const directAltLink = getPathQualifiedLink(normalizedAltLink);
  if (directAltLink) {
    const fileFromAlt = resolveLink(app, directAltLink, activeFile);
    if (fileFromAlt) return fileFromAlt;
  }

  const directSrcLink = getPathQualifiedLink(srcLinkPath);
  if (directSrcLink) {
    const fileFromSrc = resolveLink(app, directSrcLink, activeFile);
    if (fileFromSrc) return fileFromSrc;
  }

  if (basenameCandidate) {
    const fileFromNoteCache = getFileFromNoteEmbedCache(app, activeFile, basenameCandidate);
    if (fileFromNoteCache.ambiguous) return null;
    if (fileFromNoteCache.file) return fileFromNoteCache.file;
    if (fileFromNoteCache.cacheAvailable) {
      const uniqueVaultFile = getUniqueVaultFileByBaseName(app, basenameCandidate);
      if (uniqueVaultFile.ambiguous) return null;
      if (uniqueVaultFile.file) return uniqueVaultFile.file;
      return null;
    }
  }

  const fileFromAlt = getFileFromBaseNameLink(app, normalizedAltLink, activeFile, basenameCandidate);
  if (fileFromAlt) return fileFromAlt;

  if (srcLinkPath) {
    const fileFromSrc = getFileFromBaseNameLink(app, srcLinkPath, activeFile, basenameCandidate);
    if (fileFromSrc) return fileFromSrc;
  }

  return null;
}

/**
 * 把 `<img>` 认回「所在笔记 + 库内文件」。`showNotice` 为真且确实是一张图
 * 时，认不出会提示一句——用于区分「这不是图」与「是图但找不到文件」。
 */
export async function resolveImageFile(
  app: App,
  img: HTMLImageElement,
  showNotice = true,
  activeFileOverride?: TFile
): Promise<{ activeFile: TFile; imgFile: TFile } | null> {
  const activeFile = activeFileOverride ?? app.workspace.getActiveFile();
  if (!activeFile) return null;

  const imgFile = getFileForImage(app, img, activeFile);
  if (!imgFile) {
    if (showNotice && (img.naturalWidth > 0 || img.src)) {
      new Notice(NOTICE_FAILED.couldNotLocateImage);
    }
    return null;
  }

  return { activeFile, imgFile };
}

/** 在访达 / 资源管理器中定位该文件。 */
export async function showInSystemExplorer(app: App, file: TFile): Promise<void> {
  (app as unknown as AppWithSystemFileOps).showInFolder(file.path);
}

/** 用系统默认应用打开该文件。 */
export async function openInDefaultApp(app: App, file: TFile): Promise<void> {
  (app as unknown as AppWithSystemFileOps).openWithDefaultApp(file.path);
}

/** 重命名图像：先问新名字，再沿用原目录改路径（Obsidian 会同步更新链接）。 */
export async function renameImage(app: App, file: TFile): Promise<void> {
  const newName = await promptForNewName(app, file);
  if (!newName) return;

  try {
    const dirPath = file.parent?.path || '/';
    await app.fileManager.renameFile(file, `${dirPath}/${newName}`);
    new Notice(NOTICE_DONE.imageRenamed);
  } catch (error) {
    log.error('LOG_RENAME_FAILED', { path: file.path, error: String(error) });
    new Notice(NOTICE_FAILED.failedToRename);
  }
}

function promptForNewName(app: App, file: TFile): Promise<string | null> {
  return new Promise(resolve => {
    new RenameImageModal(app, file.name, resolve).open();
  });
}

/**
 * 删除图像及其在当前笔记中的全部链接。按设置决定是否先弹确认框。
 *
 * 顺序是：先清链接再删文件——反过来的话，删文件会让 Obsidian 自己改写笔记，
 * 我们就失去了对「删掉哪些链接」的控制权。
 */
export async function deleteImageAndLink(
  app: App,
  file: TFile,
  settings: PixelPerfectImageSettings
): Promise<void> {
  const performDeletion = async (): Promise<void> => {
    try {
      const activeFile = app.workspace.getActiveFile();
      const linksRemoved = activeFile
        ? await removeImageLinks(app, activeFile, file)
        : false;

      await trashFile(app, file);

      new Notice(linksRemoved ? NOTICE_DONE.imageAndLinksDeleted : NOTICE_DONE.imageDeleted);
    } catch (error) {
      log.error('LOG_DELETE_FAILED', { path: file.path, error: String(error) });
      new Notice(NOTICE_FAILED.failedToDelete);
    }
  };

  if (settings.confirmBeforeDelete) {
    new DeleteImageConfirmModal(app, file, () => {
      void performDeletion();
    }).open();
    return;
  }

  await performDeletion();
}
