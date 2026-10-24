/**
 * @vitest-environment jsdom
 *
 * Tests for the mobile stacked presentation: the sizing plan, the orientation
 * carrier lookup, and the two writes that neutralise Obsidian's own embed
 * sizing (the width/height attributes and the rotate transform).
 */
import { describe, it, expect } from 'vitest';
import {
  layoutMobileEmbed,
  mobileOrientationOf,
  planMobileBox,
} from '../src/imageRender/mobileStack';
import { IDENTITY_STATE, type OrientationState } from '../src/imageTransform/orientation';

const R90: OrientationState = { turns: 1, mirror: false };
const R270: OrientationState = { turns: 3, mirror: false };

describe('planMobileBox', () => {
  it('keeps an image that already fits at its natural size', () => {
    const plan = planMobileBox(300, 150, 400, IDENTITY_STATE)!;
    expect(plan).toMatchObject({
      boxWidth: 300,
      boxHeight: 150,
      shownWidth: 300,
      shownHeight: 150,
      scale: 1,
      turned: false,
    });
  });

  it('never enlarges a small image', () => {
    const plan = planMobileBox(100, 80, 400, IDENTITY_STATE)!;
    expect(plan.shownWidth).toBe(100);
    expect(plan.shownHeight).toBe(80);
  });

  it('shrinks a wide image to the page width', () => {
    const plan = planMobileBox(1000, 500, 400, IDENTITY_STATE)!;
    expect(plan.boxWidth).toBe(400);
    expect(plan.boxHeight).toBe(200);
    expect(plan.shownWidth).toBe(400);
    expect(plan.shownHeight).toBe(200);
  });

  it('fits a quarter turn by the width it is shown at', () => {
    // 1000x500 turned 90° shows 500 wide; the page is 400, so it narrows to it.
    const plan = planMobileBox(1000, 500, 400, R90)!;
    expect(plan.turned).toBe(true);
    expect(plan.boxWidth).toBe(800);
    expect(plan.boxHeight).toBe(400);
    expect(plan.shownWidth).toBe(400);
    expect(plan.shownHeight).toBe(800);
    expect(plan.scale).toBe(1);
  });

  it('turns a portrait into a page-width landscape', () => {
    const plan = planMobileBox(500, 1000, 400, R270)!;
    expect(plan.turned).toBe(true);
    expect(plan.shownWidth).toBe(400);
    expect(plan.shownHeight).toBe(200);
  });

  it('returns null until the bitmap and the page have a size', () => {
    expect(planMobileBox(0, 100, 400, IDENTITY_STATE)).toBeNull();
    expect(planMobileBox(100, 100, 0, IDENTITY_STATE)).toBeNull();
  });
});

describe('mobileOrientationOf', () => {
  it('reads the word from the embed itself', () => {
    const embed = createDiv();
    embed.setAttribute('data-diaa-orientation', 'r90');
    expect(mobileOrientationOf(embed)).toEqual(R90);
  });

  it('inherits the word from the marked line', () => {
    const line = createDiv();
    line.setAttribute('data-diaa-orientation', 'r270');
    const embed = createSpan();
    line.appendChild(embed);
    expect(mobileOrientationOf(embed)).toEqual(R270);
  });

  it('treats a missing word as identity', () => {
    expect(mobileOrientationOf(createSpan())).toEqual(IDENTITY_STATE);
  });
});

function mediaHost(naturalWidth: number, naturalHeight: number, pageWidth = 400): {
  embed: HTMLElement;
  img: HTMLImageElement;
} {
  const host = createDiv();
  const embed = createSpan();
  embed.className = 'internal-embed';
  const img = createEl('img');
  Object.defineProperty(img, 'naturalWidth', { value: naturalWidth });
  Object.defineProperty(img, 'naturalHeight', { value: naturalHeight });
  Object.defineProperty(img, 'complete', { value: true });
  embed.appendChild(img);
  host.appendChild(embed);
  Object.defineProperty(host, 'getBoundingClientRect', {
    value: () => ({ width: pageWidth }),
  });
  return { embed, img };
}

describe('layoutMobileEmbed', () => {
  it('replaces Obsidian\'s width attribute with the fitted box', () => {
    const { embed, img } = mediaHost(1000, 500);
    img.setAttribute('width', '100');
    layoutMobileEmbed(embed);
    expect(img.hasAttribute('width')).toBe(false);
    expect(img.style.width).toBe('400px');
    expect(img.style.height).toBe('200px');
    expect(embed.style.width).toBe('');
  });

  it('gives the embed the drawn rectangle for a quarter turn', () => {
    const { embed, img } = mediaHost(1000, 500);
    embed.setAttribute('data-diaa-orientation', 'r90');
    layoutMobileEmbed(embed);
    expect(embed.classList.contains('diaa-mobile-turned')).toBe(true);
    expect(embed.style.width).toBe('400px');
    expect(embed.style.height).toBe('800px');
    expect(img.style.width).toBe('800px');
    expect(img.style.height).toBe('400px');
    expect(img.style.maxWidth).toBe('none');
    expect(img.style.transform).toBe('rotate(90deg)');
  });

  it('replays a flip without swapping the box', () => {
    const { embed, img } = mediaHost(300, 150);
    embed.setAttribute('data-diaa-orientation', 'fh');
    layoutMobileEmbed(embed);
    expect(embed.classList.contains('diaa-mobile-turned')).toBe(false);
    expect(img.style.transform).toBe('scaleX(-1)');
    expect(img.style.width).toBe('300px');
  });
});
