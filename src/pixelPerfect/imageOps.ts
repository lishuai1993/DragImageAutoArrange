import { type App, Notice, requestUrl, type TFile } from 'obsidian';
import { logger } from '../logger';
import { resolveImageFile } from './fileOps';
import {
  createUserVisibleError,
  findMarkdownEditorForFile,
  getBestHttpImageSource,
  isHttpUrlString,
  isLocalNetworkUrl,
  isUserVisibleError,
} from './imageSourceUtils';
import {
  findCurrentExternalImageWidthInText,
  findCurrentImageWidthInText,
  findLastObsidianImageSizeParam,
  updateExternalImageLinks,
  updateImageLinks,
} from './imageLinkOps';
import { NOTICE_FAILED, NOTICE_TEMPLATE } from './menuTexts';
import { DEFAULT_EXTERNAL_IMAGE_FALLBACK_WIDTH_PX } from './ppSettingsModel';

const log = logger.channel('imageOps');

/**
 * 图像的读写：读出真实像素尺寸、把图送进系统剪贴板、按尺寸预设改写链接宽度。
 *
 * 剪贴板的难点在跨源：直接 `canvas.drawImage` 一张外域图会污染画布，
 * `toBlob` 随之失败。这里先走「就地取已渲染的图」这条快路径，失败再按来源
 * 分流——http(s) 交给 Obsidian 的 `requestUrl` 绕开同源策略取回再画，本地
 * / app/blob 地址则直接按图加载。外域请求额外做了体积上限与超时，避免把
 * 一张巨图或一个挂住的地址拖垮整个插件。
 */

/** 画布重编码的体积与尺寸上限。 */
const CLIPBOARD_COPY_MAX_BYTES = 25 * 1024 * 1024;
const CLIPBOARD_COPY_MAX_PIXELS = 40_000_000;
const CLIPBOARD_COPY_MAX_DIMENSION = 12_000;
const CLIPBOARD_COPY_REQUEST_TIMEOUT_MS = 15_000;

/** 尺寸读盘缓存，避免同一张图反复解码；超过上限按插入顺序淘汰最旧的。 */
const DIMENSION_CACHE_MAX_ENTRIES = 300;
const dimensionCache = new Map<string, { width: number; height: number }>();

/** 同一 URL 的取图请求合流，避免连点复制时打出多个并行下载。 */
const externalImageFetchInFlight = new Map<string, Promise<Blob>>();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(createUserVisibleError(timeoutMessage)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
}

function getMimeTypeForExtension(extension: string): string {
  switch (extension.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/*';
  }
}

function loadImage(src: string, crossOrigin?: 'anonymous'): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = src;
  });
}

function createBlob(data: ArrayBuffer, type: string): Blob {
  return new Blob([new Uint8Array(data)], { type });
}

// ── 画布 → 剪贴板 ──────────────────────────────────────────────────────

function assertCopySizeOk(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw createUserVisibleError(NOTICE_FAILED.couldNotDetermineImageDimensions);
  if (width > CLIPBOARD_COPY_MAX_DIMENSION || height > CLIPBOARD_COPY_MAX_DIMENSION) {
    throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);
  }
  if (width * height > CLIPBOARD_COPY_MAX_PIXELS) {
    throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);
  }
}

async function canvasToClipboard(source: CanvasImageSource, width: number, height: number): Promise<void> {
  assertCopySizeOk(width, height);

  const canvas = createEl('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get canvas context');

  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolveBlob => {
    canvas.toBlob(resolveBlob, 'image/png');
  });
  if (!blob) throw new Error('Failed to create blob');
  if (blob.size > CLIPBOARD_COPY_MAX_BYTES) throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);

  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

// ── 外域取图 ───────────────────────────────────────────────────────────

function parseContentLength(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.['content-length'] ?? headers?.['Content-Length'] ?? headers?.['CONTENT-LENGTH'];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseContentType(headers: Record<string, string> | undefined): string | null {
  const raw = headers?.['content-type'] ?? headers?.['Content-Type'] ?? headers?.['CONTENT-TYPE'];
  return raw?.split(';', 1)[0]?.trim() || null;
}

function parseContentRangeTotal(headers: Record<string, string> | undefined): number | null {
  const raw = headers?.['content-range'] ?? headers?.['Content-Range'] ?? headers?.['CONTENT-RANGE'];
  if (!raw) return null;
  // 形如 "bytes 0-0/12345" 或 "bytes 0-0/*"
  const match = raw.match(/\/(\d+|\*)\s*$/);
  if (!match || match[1] === '*') return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** 按文件头嗅探图片类型：响应头的 content-type 未必可信。 */
function sniffImageMimeType(data: ArrayBuffer): string | null {
  const bytes = new Uint8Array(data.slice(0, 256));

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';

  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return 'image/x-icon';
  }

  // AVIF (ISO BMFF): ....ftypavif / ....ftypavis
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }

  try {
    const prefix = new TextDecoder('utf-8').decode(bytes);
    if (prefix.trimStart().toLowerCase().includes('<svg')) return 'image/svg+xml';
  } catch {
    // 解码失败就当作未知类型
  }

  return null;
}

function looksLikeHtml(data: ArrayBuffer): boolean {
  try {
    const bytes = new Uint8Array(data.slice(0, 512));
    const trimmed = new TextDecoder('utf-8').decode(bytes).trimStart().toLowerCase();
    return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html') || trimmed.includes('<html');
  } catch {
    return false;
  }
}

/**
 * 取回外域图片。先用 `Range: bytes=0-0` 探测总长度，能在下载前就否掉超限的
 * 图；服务器忽略 Range 直接回 200 时则复用这次响应，不重复下载。
 * 注意 `requestUrl` 无法中断，探测只是尽力而为。
 */
function getExternalImageBlobPromise(url: string): Promise<Blob> {
  const existing = externalImageFetchInFlight.get(url);
  if (existing) return existing;

  const fetchPromise = (async (): Promise<Blob> => {
    if (isLocalNetworkUrl(url)) {
      new Notice(NOTICE_TEMPLATE.fetchingLocalNetworkImage);
    }

    const baseHeaders = { Accept: 'image/*' };
    let alreadyFetched: { arrayBuffer: ArrayBuffer; headers: Record<string, string>; status: number } | null = null;

    try {
      const probe = await requestUrl({ url, method: 'GET', throw: false, headers: { ...baseHeaders, Range: 'bytes=0-0' } });

      if (probe.status === 200) {
        alreadyFetched = { arrayBuffer: probe.arrayBuffer, headers: probe.headers, status: probe.status };
      } else if (probe.status === 206) {
        const total = parseContentRangeTotal(probe.headers);
        if (total !== null && total > CLIPBOARD_COPY_MAX_BYTES) {
          throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);
        }
      }
    } catch (error) {
      if (isUserVisibleError(error) && error.message === NOTICE_FAILED.imageTooLargeToCopy) throw error;
    }

    const response = alreadyFetched ?? (await requestUrl({ url, method: 'GET', throw: false, headers: baseHeaders }));

    if (response.status < 200 || response.status >= 300) {
      throw createUserVisibleError(
        NOTICE_TEMPLATE.failedToFetchExternalImage.replace('{status}', String(response.status))
      );
    }

    const headerLength = parseContentLength(response.headers);
    if (headerLength !== null && headerLength > CLIPBOARD_COPY_MAX_BYTES) {
      throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);
    }

    const arrayBuffer = response.arrayBuffer;
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength <= 0) {
      throw createUserVisibleError(
        NOTICE_TEMPLATE.failedToFetchExternalImage.replace('{status}', String(response.status))
      );
    }
    if (arrayBuffer.byteLength > CLIPBOARD_COPY_MAX_BYTES) {
      throw createUserVisibleError(NOTICE_FAILED.imageTooLargeToCopy);
    }

    const sniffedContentType = sniffImageMimeType(arrayBuffer);
    const normalizedHeaderContentType = parseContentType(response.headers)?.toLowerCase();
    const headerIsImage = normalizedHeaderContentType?.startsWith('image/') ?? false;

    if (
      !sniffedContentType &&
      (normalizedHeaderContentType === 'text/html' ||
        normalizedHeaderContentType === 'application/xhtml+xml' ||
        looksLikeHtml(arrayBuffer))
    ) {
      throw createUserVisibleError(NOTICE_TEMPLATE.externalImageNotImage);
    }

    const contentType = headerIsImage ? (normalizedHeaderContentType as string) : (sniffedContentType ?? '');
    return contentType ? new Blob([arrayBuffer], { type: contentType }) : new Blob([arrayBuffer]);
  })();

  externalImageFetchInFlight.set(url, fetchPromise);
  void fetchPromise.then(
    () => externalImageFetchInFlight.delete(url),
    () => externalImageFetchInFlight.delete(url)
  );
  return fetchPromise;
}

async function fetchExternalImageAsObjectUrl(url: string): Promise<{ objectUrl: string; revoke: () => void }> {
  const blob = await withTimeout(
    getExternalImageBlobPromise(url),
    CLIPBOARD_COPY_REQUEST_TIMEOUT_MS,
    NOTICE_TEMPLATE.externalImageFetchTimedOut
  );
  const objectUrl = URL.createObjectURL(blob);
  return { objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
}

/** 送进剪贴板的地址：优先 http(s)，否则用已解析的 currentSrc。 */
function getClipboardImageSrc(targetImg: HTMLImageElement): string {
  const http = getBestHttpImageSource(targetImg);
  if (isHttpUrlString(http)) return http;
  // 本地 / app / blob 地址优先用已解析的 currentSrc，`data-src` 可能是相对路径。
  return targetImg.currentSrc || targetImg.src || http;
}

/** 把一张图的位图写入系统剪贴板。 */
export async function copyImageToClipboard(targetImg: HTMLImageElement): Promise<void> {
  try {
    const src = getClipboardImageSrc(targetImg);
    if (!src) throw new Error('No image source found');

    // 快路径：画布可以直接吃已渲染的图元素，省掉一次下载。
    try {
      await canvasToClipboard(targetImg, targetImg.naturalWidth || targetImg.width, targetImg.naturalHeight || targetImg.height);
      return;
    } catch (error) {
      // 外域且未开 CORS 时画布被污染，toBlob 会失败——这类错误继续走兜底路径。
      if (isUserVisibleError(error)) throw error;
    }

    if (isHttpUrlString(src)) {
      const { objectUrl, revoke } = await fetchExternalImageAsObjectUrl(src);
      try {
        const img = await loadImage(objectUrl);
        await canvasToClipboard(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
      } finally {
        revoke();
      }
      return;
    }

    const img = await loadImage(src, 'anonymous');
    await canvasToClipboard(img, img.naturalWidth || img.width, img.naturalHeight || img.height);
  } catch (error) {
    log.error('LOG_COPY_FAILED', { error: String(error) });
    if (error instanceof Error && error.message.includes('Document is not focused')) {
      throw createUserVisibleError(NOTICE_FAILED.clickInEditorFirst);
    }
    throw error;
  }
}

// ── 尺寸读取 ───────────────────────────────────────────────────────────

function setDimensionCache(path: string, dimensions: { width: number; height: number }): void {
  dimensionCache.set(path, dimensions);
  if (dimensionCache.size <= DIMENSION_CACHE_MAX_ENTRIES) return;
  const oldestKey = dimensionCache.keys().next().value;
  if (oldestKey !== undefined) dimensionCache.delete(oldestKey);
}

/** 清空尺寸缓存（文件变更后由调用方触发）。 */
export function clearDimensionCache(): void {
  dimensionCache.clear();
}

/** 文本解码：认 BOM 与 UTF-16 启发式，覆盖各种编辑器产出的 SVG。 */
function decodeText(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);

  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      // 换成小端以兼容更广的解码器。
      const swapped = new Uint8Array(bytes.length);
      swapped.set(bytes);
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const a = swapped[i];
        swapped[i] = swapped[i + 1];
        swapped[i + 1] = a;
      }
      return new TextDecoder('utf-16le').decode(swapped);
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  const utf8 = new TextDecoder('utf-8').decode(bytes);
  // 大量 NUL 通常意味着无 BOM 的 UTF-16LE。
  if (utf8.slice(0, 200).includes('\u0000')) {
    try {
      return new TextDecoder('utf-16le').decode(bytes);
    } catch {
      // 解不开就用 UTF-8 结果
    }
  }

  return utf8;
}

function parseSvgLengthToPx(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^([+-]?(?:\d+|\d*\.\d+))\s*([a-z%]*)$/i);
  if (!match) return null;

  const numberValue = Number(match[1]);
  if (!Number.isFinite(numberValue)) return null;

  const unit = (match[2] || '').toLowerCase();
  if (unit === '' || unit === 'px') return numberValue;

  // SVG / CSS 绝对单位，按 96 CSS px = 1 inch 换算。
  switch (unit) {
    case 'in':
      return numberValue * 96;
    case 'cm':
      return (numberValue * 96) / 2.54;
    case 'mm':
      return (numberValue * 96) / 25.4;
    case 'pt':
      return (numberValue * 96) / 72;
    case 'pc':
      return numberValue * 16; // 12pt = 16px
    case 'q':
      return (numberValue * 96) / 101.6;
    default:
      return null;
  }
}

/**
 * 从二进制里解析 SVG 尺寸。
 *
 * 取舍：`width` / `height` 优先（换算成 px 后）；`viewBox` 只当宽高比的线索，
 * 不当固有像素尺寸——浏览器在缺 width/height 时默认视口是 300×150，照此
 * 兜底才不会把一张比例图算成别的大小。
 */
function readSvgDimensionsFromBinary(data: ArrayBuffer): { width: number; height: number } | null {
  try {
    const svgText = decodeText(data);

    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const svg = doc.querySelector('svg');
    const widthAttr = svg?.getAttribute('width') ?? null;
    const heightAttr = svg?.getAttribute('height') ?? null;
    const viewBoxAttr = svg?.getAttribute('viewBox') ?? svg?.getAttribute('viewbox') ?? null;

    // 正则兜底：XML 畸变或解析器怪癖时仍能拿到属性。
    const svgTag = svgText.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const widthAttrRegex = svgTag.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    const heightAttrRegex = svgTag.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
    const viewBoxAttrRegex =
      svgTag.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1] ??
      svgTag.match(/\bviewbox\s*=\s*["']([^"']+)["']/i)?.[1] ??
      null;

    const widthPx = parseSvgLengthToPx(widthAttr) ?? parseSvgLengthToPx(widthAttrRegex);
    const heightPx = parseSvgLengthToPx(heightAttr) ?? parseSvgLengthToPx(heightAttrRegex);
    const viewBox = viewBoxAttr ?? viewBoxAttrRegex;

    const normalizedWidthPx = widthPx !== null && widthPx > 0 ? widthPx : null;
    const normalizedHeightPx = heightPx !== null && heightPx > 0 ? heightPx : null;

    if (normalizedWidthPx !== null && normalizedHeightPx !== null) {
      return { width: Math.round(normalizedWidthPx), height: Math.round(normalizedHeightPx) };
    }

    if (viewBox) {
      const parts = viewBox.trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4 && parts.every(n => Number.isFinite(n))) {
        const [, , vbWidth, vbHeight] = parts;
        if (vbWidth > 0 && vbHeight > 0) {
          if (normalizedWidthPx === null && normalizedHeightPx === null) return { width: 300, height: 150 };
          if (normalizedWidthPx !== null && normalizedHeightPx === null) {
            return { width: Math.round(normalizedWidthPx), height: Math.round((normalizedWidthPx * vbHeight) / vbWidth) };
          }
          if (normalizedWidthPx === null && normalizedHeightPx !== null) {
            return { width: Math.round((normalizedHeightPx * vbWidth) / vbHeight), height: Math.round(normalizedHeightPx) };
          }
        }
      }
    }

    if (normalizedWidthPx === null && normalizedHeightPx === null) return { width: 300, height: 150 };
    if (normalizedWidthPx !== null && normalizedHeightPx === null) {
      return { width: Math.round(normalizedWidthPx), height: 150 };
    }
    if (normalizedWidthPx === null && normalizedHeightPx !== null) {
      return { width: 300, height: Math.round(normalizedHeightPx) };
    }

    return { width: 300, height: 150 };
  } catch {
    return null;
  }
}

/** 读出一张图的真实像素尺寸（SVG 先走文本解析，位图走解码）。 */
export async function readImageDimensions(
  app: App,
  file: TFile
): Promise<{ width: number; height: number }> {
  const cached = dimensionCache.get(file.path);
  if (cached) return cached;

  const data = await app.vault.readBinary(file);
  const isSvg = file.extension.toLowerCase() === 'svg';
  const parsedSvgDimensions = isSvg ? readSvgDimensionsFromBinary(data) : null;

  // SVG 走 Image() 解码可能失败，先用手工解析的结果。
  if (isSvg && parsedSvgDimensions) {
    setDimensionCache(file.path, parsedSvgDimensions);
    return parsedSvgDimensions;
  }

  const url = URL.createObjectURL(createBlob(data, getMimeTypeForExtension(file.extension)));
  try {
    const img = await loadImage(url);
    const dimensions = { width: img.naturalWidth || img.width, height: img.naturalHeight || img.height };

    const hasValidDimensions =
      Number.isFinite(dimensions.width) &&
      Number.isFinite(dimensions.height) &&
      dimensions.width > 0 &&
      dimensions.height > 0;

    if (!hasValidDimensions) {
      throw createUserVisibleError(
        isSvg ? NOTICE_FAILED.couldNotDetermineSvgDimensions : NOTICE_FAILED.couldNotDetermineImageDimensions
      );
    }

    setDimensionCache(file.path, dimensions);
    return dimensions;
  } catch (error) {
    if (isSvg && !isUserVisibleError(error)) {
      throw createUserVisibleError(NOTICE_FAILED.couldNotDetermineSvgDimensions);
    }
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ── 链接宽度读写 ───────────────────────────────────────────────────────

/** 读当前笔记里该图已设置的宽度，没设过返回 null。 */
export function getCurrentImageWidth(app: App, activeFile: TFile, imageFile: TFile): number | null {
  const editor = findMarkdownEditorForFile(app, activeFile);
  if (!editor) return null;
  return findCurrentImageWidthInText(app, activeFile, imageFile, editor.getValue());
}

/** 同上，用于外域图片（按 URL 匹配）。 */
export function getCurrentExternalImageWidth(app: App, activeFile: TFile, imageUrl: string): number | null {
  const editor = findMarkdownEditorForFile(app, activeFile);
  if (!editor) return null;
  return findCurrentExternalImageWidthInText(imageUrl, editor.getValue());
}

/**
 * 把尺寸参数写回链接：已有的尺寸参数就地替换（若是 `宽x高` 形式则丢掉高度，
 * 本插件只按宽度调），没有则追加到参数末尾，其余属性原样保留。
 */
async function updateImageLinkWidth(
  app: App,
  imageFile: TFile,
  newWidth: number,
  activeFileOverride?: TFile
): Promise<void> {
  const activeFile = activeFileOverride ?? app.workspace.getActiveFile();
  if (!activeFile) throw new Error('No active file, cannot update link.');

  await updateImageLinks(app, activeFile, imageFile, params => {
    const sizeParam = findLastObsidianImageSizeParam(params);
    if (sizeParam) {
      return [...params.slice(0, sizeParam.index), String(newWidth), ...params.slice(sizeParam.index + 1)];
    }
    return [...params, String(newWidth)];
  });
}

async function updateExternalImageLinkWidth(
  app: App,
  activeFile: TFile,
  imageUrl: string,
  newWidth: number
): Promise<void> {
  await updateExternalImageLinks(app, activeFile, imageUrl, params => {
    const sizeParam = findLastObsidianImageSizeParam(params);
    if (sizeParam) {
      return [...params.slice(0, sizeParam.index), String(newWidth), ...params.slice(sizeParam.index + 1)];
    }
    return [...params, String(newWidth)];
  });
}

/** 按百分比或绝对像素调整库内图片的链接宽度。 */
export async function resizeImage(
  app: App,
  img: HTMLImageElement,
  size: number,
  isAbsolute = false,
  activeFileOverride?: TFile
): Promise<void> {
  const result = await resolveImageFile(app, img, false, activeFileOverride);
  if (!result) throw createUserVisibleError(NOTICE_FAILED.couldNotLocateImage);

  if (isAbsolute) {
    await updateImageLinkWidth(app, result.imgFile, size, result.activeFile);
    return;
  }

  const { width } = await readImageDimensions(app, result.imgFile);
  await updateImageLinkWidth(app, result.imgFile, Math.round((width * size) / 100), result.activeFile);
}

/** 同上，用于外域图片：百分比基于图的固有宽度，未加载出来时用兜底宽度。 */
export async function resizeExternalImage(
  app: App,
  activeFile: TFile,
  imageUrl: string,
  img: HTMLImageElement,
  size: number,
  isAbsolute = false
): Promise<void> {
  if (isAbsolute) {
    await updateExternalImageLinkWidth(app, activeFile, imageUrl, size);
    return;
  }

  const baseWidth = img.naturalWidth > 0 ? img.naturalWidth : DEFAULT_EXTERNAL_IMAGE_FALLBACK_WIDTH_PX;
  await updateExternalImageLinkWidth(app, activeFile, imageUrl, Math.round((baseWidth * size) / 100));
}

/** 移除库内图片的尺寸参数。 */
export async function removeImageWidth(
  app: App,
  imageFile: TFile,
  activeFileOverride?: TFile
): Promise<void> {
  const activeFile = activeFileOverride ?? app.workspace.getActiveFile();
  if (!activeFile) throw new Error('No active file, cannot update link.');

  await updateImageLinks(app, activeFile, imageFile, params => {
    const sizeParam = findLastObsidianImageSizeParam(params);
    if (!sizeParam) return params;
    return [...params.slice(0, sizeParam.index), ...params.slice(sizeParam.index + 1)];
  });
}

/** 移除外域图片的尺寸参数。 */
export async function removeExternalImageWidth(
  app: App,
  activeFile: TFile,
  imageUrl: string
): Promise<void> {
  await updateExternalImageLinks(app, activeFile, imageUrl, params => {
    const sizeParam = findLastObsidianImageSizeParam(params);
    if (!sizeParam) return params;
    return [...params.slice(0, sizeParam.index), ...params.slice(sizeParam.index + 1)];
  });
}

/** 从 `alt` 里读出已设置的宽度（`alt` 形如 `图.png|200`）。 */
export function parseWidthFromImageAlt(img: HTMLImageElement): number | null {
  const alt = img.getAttribute('alt') ?? '';
  if (!alt) return null;
  const parts = alt.split('|').map(part => part.trim()).filter(Boolean);
  return findLastObsidianImageSizeParam(parts)?.width ?? null;
}

/** `<img>` 自然尺寸（未渲染 / 未加载时为 null）。 */
export function getRasterNaturalDimensions(img: HTMLImageElement): { width: number; height: number } | null {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (width > 0 && height > 0) return { width, height };
  return null;
}
