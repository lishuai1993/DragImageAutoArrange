/**
 * @vitest-environment jsdom
 *
 * The DOM-query half of the media abstraction: `queryMedia` / `queryAllMedia`
 * fold the `<img>` vs `<video>` difference behind one lookup so the renderers
 * treat both as one media element.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { queryMedia, queryAllMedia } from '../src/imageMedia/mediaElement';

describe('queryMedia', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns the first img', () => {
    const root = document.body.createDiv();
    const img = root.createEl('img');
    expect(queryMedia(root)).toBe(img);
  });

  it('returns the first video', () => {
    const root = document.body.createDiv();
    const video = root.createEl('video');
    expect(queryMedia(root)).toBe(video);
  });

  it('returns the video when both are present, in document order', () => {
    const root = document.body.createDiv();
    const video = root.createEl('video');
    root.createEl('img');
    expect(queryMedia(root)).toBe(video);
  });

  it('returns null when no media element exists', () => {
    const root = document.body.createDiv({ text: 'just text' });
    expect(queryMedia(root)).toBeNull();
  });
});

describe('queryAllMedia', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns every img and video in document order', () => {
    const root = document.body.createDiv();
    const a = root.createEl('img');
    const v = root.createEl('video');
    const b = root.createEl('img');
    expect(queryAllMedia(root)).toEqual([a, v, b]);
  });

  it('returns an empty array for a media-free root', () => {
    const root = document.body.createDiv({ text: 'no media' });
    expect(queryAllMedia(root)).toEqual([]);
  });
});
