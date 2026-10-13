import { describe, it, expect } from 'vitest';
import {
  combinedMediaExtensions,
  isVideo,
  buildImageLineRe,
  buildImageEmbedRe,
  VIDEO_EXTENSIONS_DEFAULT,
} from '../src/constants';
import {
  isMediaVideo,
  mediaNaturalSize,
  mediaLoaded,
} from '../src/imageMedia/mediaElement';
import { detectRowGroups } from '../src/imageParse/imageDetector';

describe('combinedMediaExtensions', () => {
  it('merges, trims and dedupes the two extension lists', () => {
    expect(combinedMediaExtensions('png,jpg', 'mp4,webm')).toBe('png,jpg,mp4,webm');
  });

  it('keeps image order then appends unseen video extensions', () => {
    expect(combinedMediaExtensions('png, mp4, gif', 'mp4, webm')).toBe('png,mp4,gif,webm');
  });

  it('drops empty tokens', () => {
    expect(combinedMediaExtensions('png,,jpg,', ',mp4,')).toBe('png,jpg,mp4');
  });
});

describe('isVideo', () => {
  it('matches a video extension case-insensitively', () => {
    expect(isVideo('clip.MP4', VIDEO_EXTENSIONS_DEFAULT)).toBe(true);
    expect(isVideo('clip.webm', VIDEO_EXTENSIONS_DEFAULT)).toBe(true);
    expect(isVideo('clip.mov', VIDEO_EXTENSIONS_DEFAULT)).toBe(true);
  });

  it('rejects image and extension-less names', () => {
    expect(isVideo('pic.png', VIDEO_EXTENSIONS_DEFAULT)).toBe(false);
    expect(isVideo('noext', VIDEO_EXTENSIONS_DEFAULT)).toBe(false);
  });
});

describe('isMediaVideo', () => {
  it('detects a video by tag name, robust to test DOMs', () => {
    expect(isMediaVideo({ tagName: 'VIDEO' } as HTMLElement)).toBe(true);
    expect(isMediaVideo({ tagName: 'IMG' } as HTMLElement)).toBe(false);
    expect(isMediaVideo(null)).toBe(false);
    expect(isMediaVideo(undefined)).toBe(false);
  });
});

describe('mediaNaturalSize', () => {
  it('reads videoWidth/videoHeight from a video', () => {
    const v = { tagName: 'VIDEO', videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement;
    expect(mediaNaturalSize(v)).toEqual({ w: 1920, h: 1080 });
  });

  it('reads naturalWidth/naturalHeight from an image', () => {
    const img = { tagName: 'IMG', naturalWidth: 640, naturalHeight: 480 } as unknown as HTMLImageElement;
    expect(mediaNaturalSize(img)).toEqual({ w: 640, h: 480 });
  });

  it('returns 0×0 for null', () => {
    expect(mediaNaturalSize(null)).toEqual({ w: 0, h: 0 });
  });
});

describe('mediaLoaded', () => {
  it('a video is loaded once readyState reaches HAVE_METADATA (1)', () => {
    const pending = { tagName: 'VIDEO', readyState: 0 } as unknown as HTMLVideoElement;
    const loaded = { tagName: 'VIDEO', readyState: 1 } as unknown as HTMLVideoElement;
    expect(mediaLoaded(pending)).toBe(false);
    expect(mediaLoaded(loaded)).toBe(true);
  });

  it('an image is loaded once complete', () => {
    const pending = { tagName: 'IMG', complete: false } as unknown as HTMLImageElement;
    const loaded = { tagName: 'IMG', complete: true } as unknown as HTMLImageElement;
    expect(mediaLoaded(pending)).toBe(false);
    expect(mediaLoaded(loaded)).toBe(true);
  });
});

describe('video row detection', () => {
  const exts = combinedMediaExtensions('png,jpg', 'mp4,webm');

  it('buildImageLineRe matches a video embed line', () => {
    const re = buildImageLineRe(exts);
    expect(re.test('![[clip.mp4]]')).toBe(true);
    expect(re.test('![[clip.mp4|1|400]]')).toBe(true);
    expect(re.test('![[pic.png]]')).toBe(true);
    expect(re.test('![[note]]')).toBe(false);
  });

  it('buildImageEmbedRe matches a video embed inside prose', () => {
    const re = buildImageEmbedRe(exts);
    expect(re.test('文字 ![[clip.webm]] 文字')).toBe(true);
  });

  it('detectRowGroups groups consecutive video lines as a multi row', () => {
    const gs = detectRowGroups('![[a.mp4]]\n![[b.webm]]', 10, exts);
    expect(gs).toHaveLength(1);
    expect(gs[0].kind).toBe('multi');
    expect(gs[0].images.map(i => i.fileName)).toEqual(['a.mp4', 'b.webm']);
  });

  it('detectRowGroups classifies a lone video line as a single row', () => {
    const gs = detectRowGroups('![[solo.mp4]]', 10, exts);
    expect(gs).toHaveLength(1);
    expect(gs[0].kind).toBe('single');
    expect(gs[0].images[0].display).toEqual({ kind: 'single-follow' });
  });
});
