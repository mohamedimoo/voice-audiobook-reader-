import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChapterMark, LibraryFolder } from '../shared/types';
import { naturalCompare } from '../shared/chapters';

export const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm', '.mka',
]);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const PREFERRED_COVER_NAMES = ['cover', 'folder', 'front', 'albumart', 'albumartlarge', 'poster'];

export function isAudioFile(file: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function bookIdFor(root: string): string {
  return createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
}

/** A book discovered on disk, before metadata has been read. */
export interface BookCandidate {
  folderId: string;
  root: string;
  isFile: boolean;
  files: string[];
  /** Author derived from the folder structure (`authors` folders). */
  author: string | null;
}

export interface FileMeta {
  size: number;
  mtimeMs: number;
  durationMs: number;
  title: string | null;
  album: string | null;
  artist: string | null;
  marks: ChapterMark[];
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(dir: string) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => naturalCompare(a.name, b.name));
  } catch {
    return [];
  }
}

/** All audio files below a folder, in natural order (folders are walked in order too). */
export async function audioFilesIn(dir: string, depth = 0): Promise<string[]> {
  if (depth > 8) return [];
  const result: string[] = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await audioFilesIn(full, depth + 1)));
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      result.push(full);
    }
  }
  return result;
}

async function candidatesInLibrary(folder: LibraryFolder, dir: string, author: string | null): Promise<BookCandidate[]> {
  const result: BookCandidate[] = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const files = await audioFilesIn(full);
      if (files.length > 0) result.push({ folderId: folder.id, root: full, isFile: false, files, author });
    } else if (entry.isFile() && isAudioFile(entry.name)) {
      result.push({ folderId: folder.id, root: full, isFile: true, files: [full], author });
    }
  }
  return result;
}

export async function findCandidates(folder: LibraryFolder): Promise<BookCandidate[]> {
  switch (folder.kind) {
    case 'file':
      return isAudioFile(folder.path) && !(await isDirectory(folder.path))
        ? [{ folderId: folder.id, root: folder.path, isFile: true, files: [folder.path], author: null }]
        : [];
    case 'single': {
      const files = await audioFilesIn(folder.path);
      return files.length ? [{ folderId: folder.id, root: folder.path, isFile: false, files, author: null }] : [];
    }
    case 'authors': {
      const result: BookCandidate[] = [];
      for (const entry of await listDir(folder.path)) {
        const full = path.join(folder.path, entry.name);
        if (entry.isDirectory()) {
          result.push(...(await candidatesInLibrary(folder, full, entry.name)));
        } else if (entry.isFile() && isAudioFile(entry.name)) {
          result.push({ folderId: folder.id, root: full, isFile: true, files: [full], author: null });
        }
      }
      return result;
    }
    case 'library':
    default:
      return candidatesInLibrary(folder, folder.path, null);
  }
}

function chapterStartMs(chapter: { start: number; timeScale?: number; sampleOffset?: number }, sampleRate?: number): number {
  if (chapter.timeScale) return (chapter.start / chapter.timeScale) * 1000;
  if (chapter.sampleOffset !== undefined && sampleRate) return (chapter.sampleOffset / sampleRate) * 1000;
  return chapter.start;
}

/** Reads the tags, duration and chapter marks of one audio file. */
export async function readFileMeta(file: string): Promise<FileMeta> {
  const stat = await fs.stat(file);
  const base: FileMeta = {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    durationMs: 0,
    title: null,
    album: null,
    artist: null,
    marks: [],
  };
  try {
    const { parseFile } = await import('music-metadata');
    const meta = await parseFile(file, { duration: true, includeChapters: true, skipCovers: true });
    const common = meta.common;
    const sampleRate = meta.format.sampleRate;
    return {
      ...base,
      durationMs: Math.round((meta.format.duration ?? 0) * 1000),
      title: clean(common.title),
      album: clean(common.album),
      artist: clean(common.albumartist) ?? clean(common.artist) ?? clean(common.composer?.[0]),
      marks: (meta.format.chapters ?? []).map((c, i) => ({
        title: clean(c.title) ?? `Chapter ${i + 1}`,
        startMs: Math.round(chapterStartMs(c, sampleRate)),
      })),
    };
  } catch (err) {
    console.warn(`Could not read metadata of ${file}:`, (err as Error).message);
    return base;
  }
}

function clean(value: string | undefined | null): string | null {
  const trimmed = value?.replace(/\u0000/g, '').trim();
  return trimmed ? trimmed : null;
}

/** Extracts the embedded cover of an audio file, if any. */
export async function readEmbeddedCover(file: string): Promise<{ data: Uint8Array; ext: string } | null> {
  try {
    const { parseFile, selectCover } = await import('music-metadata');
    const meta = await parseFile(file, { duration: false, skipCovers: false });
    const picture = selectCover(meta.common.picture);
    if (!picture) return null;
    const ext = picture.format.includes('png') ? '.png' : picture.format.includes('webp') ? '.webp' : '.jpg';
    return { data: picture.data, ext };
  } catch {
    return null;
  }
}

/** Finds an image file next to the audio files (cover.jpg, folder.png, ...). */
export async function findFolderCover(dir: string): Promise<string | null> {
  const images = (await listDir(dir))
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
    .map((e) => e.name);
  if (images.length === 0) return null;
  const preferred = images.find((name) =>
    PREFERRED_COVER_NAMES.includes(path.basename(name, path.extname(name)).toLowerCase()),
  );
  return path.join(dir, preferred ?? images[0]);
}

export function fileTitle(file: string): string {
  return path.basename(file, path.extname(file));
}

/**
 * Picks display titles for the tracks of a book. Track tags are often useless for
 * multi-file books (every file tagged with the book title), so fall back to the
 * file names when the tags don't tell the files apart.
 */
export function trackTitles(files: string[], metas: FileMeta[]): string[] {
  const tagTitles = metas.map((m) => m.title);
  const distinct = new Set(tagTitles.filter(Boolean));
  const tagsAreUseful = files.length === 1 ? Boolean(tagTitles[0]) : distinct.size === files.length;
  return files.map((file, i) => (tagsAreUseful && tagTitles[i] ? tagTitles[i]! : fileTitle(file)));
}

export function bookName(candidate: BookCandidate, metas: FileMeta[]): string {
  if (candidate.isFile) {
    const meta = metas[0];
    return meta?.album ?? meta?.title ?? fileTitle(candidate.root);
  }
  return path.basename(candidate.root);
}
