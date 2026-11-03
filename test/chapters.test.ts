import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookPositionMs, chapterAt, chaptersOf, formatDuration, formatTime, locate, naturalCompare } from '../src/shared/chapters';
import type { Track } from '../src/shared/types';

const track = (title: string, durationMs: number, marks: Track['marks'] = []): Track => ({
  path: title,
  url: title,
  title,
  durationMs,
  marks,
});

test('one chapter per track when files have no marks', () => {
  const chapters = chaptersOf({ tracks: [track('01', 1000), track('02', 2000)] });
  assert.equal(chapters.length, 2);
  assert.deepEqual(
    chapters.map((c) => [c.title, c.trackIndex, c.startMs, c.endMs, c.bookStartMs]),
    [
      ['01', 0, 0, 1000, 0],
      ['02', 1, 0, 2000, 1000],
    ],
  );
});

test('embedded marks split a track into chapters', () => {
  const chapters = chaptersOf({
    tracks: [
      track('book', 10_000, [
        { title: 'Intro', startMs: 0 },
        { title: 'One', startMs: 3000 },
        { title: 'Two', startMs: 7000 },
      ]),
    ],
  });
  assert.deepEqual(
    chapters.map((c) => [c.title, c.startMs, c.endMs]),
    [
      ['Intro', 0, 3000],
      ['One', 3000, 7000],
      ['Two', 7000, 10_000],
    ],
  );
});

test('marks are sorted, de-duplicated and the first one starts at zero', () => {
  const chapters = chaptersOf({
    tracks: [
      track('book', 10_000, [
        { title: 'B', startMs: 5000 },
        { title: 'A', startMs: 200 },
        { title: 'B dup', startMs: 5100 },
        { title: 'Out of range', startMs: 20_000 },
      ]),
    ],
  });
  assert.deepEqual(
    chapters.map((c) => [c.title, c.startMs, c.endMs]),
    [
      ['A', 0, 5000],
      ['B', 5000, 10_000],
    ],
  );
});

test('chapterAt finds the chapter containing a position', () => {
  const chapters = chaptersOf({
    tracks: [track('a', 5000, [{ title: 'a1', startMs: 0 }, { title: 'a2', startMs: 2000 }]), track('b', 5000)],
  });
  assert.equal(chapterAt(chapters, 0, 0)?.title, 'a1');
  assert.equal(chapterAt(chapters, 0, 1999)?.title, 'a1');
  assert.equal(chapterAt(chapters, 0, 2000)?.title, 'a2');
  assert.equal(chapterAt(chapters, 1, 10)?.title, 'b');
  assert.equal(chapterAt([], 0, 0), null);
});

test('book positions convert to track positions and back', () => {
  const book = { tracks: [track('a', 1000), track('b', 2000), track('c', 3000)] };
  assert.equal(bookPositionMs(book, 2, 500), 3500);
  assert.deepEqual(locate(book, 3500), { trackIndex: 2, positionMs: 500 });
  assert.deepEqual(locate(book, 0), { trackIndex: 0, positionMs: 0 });
  assert.deepEqual(locate(book, 1000), { trackIndex: 1, positionMs: 0 });
  assert.deepEqual(locate(book, -50), { trackIndex: 0, positionMs: 0 });
  assert.deepEqual(locate(book, 99_999), { trackIndex: 2, positionMs: 3000 });
});

test('time formatting', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(65_000), '1:05');
  assert.equal(formatTime(3_725_000), '1:02:05');
  assert.equal(formatDuration(30 * 60_000), '30 min');
  assert.equal(formatDuration(120 * 60_000), '2 h');
  assert.equal(formatDuration(135 * 60_000), '2 h 15 min');
});

test('natural sort puts chapter 2 before chapter 10', () => {
  const sorted = ['Chapter 10.mp3', 'Chapter 2.mp3', 'chapter 1.mp3'].sort(naturalCompare);
  assert.deepEqual(sorted, ['chapter 1.mp3', 'Chapter 2.mp3', 'Chapter 10.mp3']);
});
