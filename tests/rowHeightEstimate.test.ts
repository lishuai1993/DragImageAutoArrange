/**
 * Regression guard for the pre-measure row height handed to CodeMirror's height
 * map (`StaticImageRowWidget.estimatedHeight`).
 *
 * The `WidgetType` default estimate is -1, which the height map reads as "one
 * text line". A row that leaves and comes back (cut → undo) was therefore
 * modelled as ~24px and the content below it shifted by the row's real height
 * until the measurement landed. The estimate now comes from the height the row
 * last rendered at, so the contract this test pins is: a positive pixel height
 * when one is known, and null — never NaN or a negative — when it is not.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { lastRenderedRowHeight, preservedMultiImageSizes } from '../src/imageRender/imageRowWidget';

const NOTE = '工作管理/note.md';
const FILES = ['图片并排测试-1782296951858.webp'];

beforeEach(() => preservedMultiImageSizes.clear());

describe('lastRenderedRowHeight', () => {
  it('returns null when the row was never rendered', () => {
    expect(lastRenderedRowHeight(NOTE, 25, FILES)).toBeNull();
  });

  it('returns the preserved container height in pixels', () => {
    preservedMultiImageSizes.set(`${NOTE}:${FILES.join(',')}`, {
      images: [],
      items: [],
      containerStyleH: '392px',
      filePath: NOTE,
    });
    expect(lastRenderedRowHeight(NOTE, 25, FILES)).toBe(392);
  });

  it('matches a row by its member files regardless of the line it sits on', () => {
    preservedMultiImageSizes.set(`${NOTE}:${FILES.join(',')}`, {
      images: [],
      items: [],
      containerStyleH: '392px',
      filePath: NOTE,
    });
    expect(lastRenderedRowHeight(NOTE, 51, FILES)).toBe(392);
    expect(lastRenderedRowHeight(NOTE, 25, ['other.png'])).toBeNull();
  });

  it('rejects an entry with no usable height', () => {
    preservedMultiImageSizes.set(`${NOTE}:${FILES.join(',')}`, {
      images: [],
      items: [],
      containerStyleH: '',
      filePath: NOTE,
    });
    expect(lastRenderedRowHeight(NOTE, 25, FILES)).toBeNull();
  });
});
