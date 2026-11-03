import type { Book, Track } from './types';

/**
 * A chapter as presented to the user. A chapter lives inside exactly one track:
 * books with one file per chapter get one chapter per track, while files that
 * carry embedded chapter marks (m4b, mp3 with CHAP frames, ...) are split up.
 */
export interface Chapter {
  index: number;
  title: string;
  trackIndex: number;
  /** Start / end inside the track, in milliseconds. */
  startMs: number;
  endMs: number;
  /** Start inside the whole book, in milliseconds. */
  bookStartMs: number;
}

const MIN_CHAPTER_MS = 500;

export function chaptersOf(book: Pick<Book, 'tracks'>): Chapter[] {
  const chapters: Chapter[] = [];
  let offset = 0;
  book.tracks.forEach((track, trackIndex) => {
    const marks = usableMarks(track);
    if (marks.length === 0) {
      chapters.push({
        index: chapters.length,
        title: track.title,
        trackIndex,
        startMs: 0,
        endMs: track.durationMs,
        bookStartMs: offset,
      });
    } else {
      marks.forEach((mark, i) => {
        const start = i === 0 ? 0 : mark.startMs;
        const end = i + 1 < marks.length ? marks[i + 1].startMs : track.durationMs;
        chapters.push({
          index: chapters.length,
          title: mark.title,
          trackIndex,
          startMs: start,
          endMs: end,
          bookStartMs: offset + start,
        });
      });
    }
    offset += track.durationMs;
  });
  return chapters;
}

/** Sorted, de-duplicated marks that fall inside the track. */
function usableMarks(track: Track) {
  const sorted = [...track.marks]
    .filter((m) => m.startMs >= 0 && (track.durationMs <= 0 || m.startMs < track.durationMs))
    .sort((a, b) => a.startMs - b.startMs);
  const result: typeof sorted = [];
  for (const mark of sorted) {
    const prev = result[result.length - 1];
    if (prev && mark.startMs - prev.startMs < MIN_CHAPTER_MS) continue;
    result.push(mark);
  }
  // A single mark carries no extra information compared to the track itself,
  // except for a nicer title.
  if (result.length === 1) return [{ ...result[0], startMs: 0 }];
  return result;
}

export function chapterAt(chapters: Chapter[], trackIndex: number, positionMs: number): Chapter | null {
  // Chapters are ordered by (trackIndex, startMs): the answer is the last one starting at or before the position.
  let found: Chapter | null = null;
  for (const chapter of chapters) {
    if (chapter.trackIndex < trackIndex || (chapter.trackIndex === trackIndex && chapter.startMs <= positionMs)) {
      found = chapter;
    } else {
      break;
    }
  }
  return found ?? chapters[0] ?? null;
}

export function bookPositionMs(book: Pick<Book, 'tracks'>, trackIndex: number, positionMs: number): number {
  let offset = 0;
  for (let i = 0; i < trackIndex && i < book.tracks.length; i++) offset += book.tracks[i].durationMs;
  return offset + positionMs;
}

/** Converts a position inside the whole book to a track index + position inside that track. */
export function locate(book: Pick<Book, 'tracks'>, bookMs: number): { trackIndex: number; positionMs: number } {
  if (book.tracks.length === 0) return { trackIndex: 0, positionMs: 0 };
  let remaining = Math.max(0, bookMs);
  for (let i = 0; i < book.tracks.length; i++) {
    const duration = book.tracks[i].durationMs;
    if (remaining < duration || i === book.tracks.length - 1) {
      return { trackIndex: i, positionMs: Math.min(remaining, Math.max(0, duration)) };
    }
    remaining -= duration;
  }
  return { trackIndex: 0, positionMs: 0 };
}

export function formatTime(ms: number, forceHours = false): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural ("human") ordering, so that "Chapter 2" sorts before "Chapter 10". */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}
