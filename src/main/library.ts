import { randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import {
  defaultBookState,
  DEFAULT_SETTINGS,
  type Book,
  type BookState,
  type LibraryFolder,
  type LibraryFolderKind,
  type LibrarySnapshot,
  type ScanProgress,
  type Settings,
} from '../shared/types';
import { JsonStore } from './store';
import {
  audioFilesIn,
  bookIdFor,
  bookName,
  findCandidates,
  findFolderCover,
  isAudioFile,
  readEmbeddedCover,
  readFileMeta,
  trackTitles,
  type BookCandidate,
  type FileMeta,
} from './scanner';

interface LibraryData {
  folders: LibraryFolder[];
  addedAt: Record<string, number>;
  states: Record<string, BookState>;
}

interface CacheData {
  version: number;
  files: Record<string, FileMeta>;
  books: Book[];
}

const CACHE_VERSION = 1;

/**
 * Library files are served through the app's own origin (`voice://app/media/...`)
 * so the renderer can route them through Web Audio without CORS tainting.
 */
export function mediaUrl(file: string): string {
  return `voice://app/media/${Buffer.from(file, 'utf8').toString('base64url')}`;
}

export function pathFromMediaUrl(url: URL): string | null {
  if (url.host !== 'app' || !url.pathname.startsWith('/media/')) return null;
  try {
    return Buffer.from(url.pathname.slice('/media/'.length), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class Library {
  private books: Book[] = [];
  private allowed = new Set<string>();
  private scanning = false;
  private rescanRequested = false;
  private scanPromise: Promise<void> | null = null;
  private watchers: FSWatcher[] = [];
  private watchTimer: NodeJS.Timeout | null = null;

  onChange: (snapshot: LibrarySnapshot) => void = () => {};
  onProgress: (progress: ScanProgress) => void = () => {};

  private constructor(
    private readonly dataDir: string,
    private readonly settingsStore: JsonStore<Settings>,
    private readonly libraryStore: JsonStore<LibraryData>,
    private readonly cacheStore: JsonStore<CacheData>,
  ) {}

  static async open(dataDir: string): Promise<Library> {
    const settings = await JsonStore.open<Settings>(path.join(dataDir, 'settings.json'), () => ({ ...DEFAULT_SETTINGS }));
    settings.set({ ...DEFAULT_SETTINGS, ...settings.get() });
    const library = await JsonStore.open<LibraryData>(path.join(dataDir, 'library.json'), () => ({
      folders: [],
      addedAt: {},
      states: {},
    }));
    const cache = await JsonStore.open<CacheData>(
      path.join(dataDir, 'cache.json'),
      () => ({ version: CACHE_VERSION, files: {}, books: [] }),
      2000,
    );
    if (cache.get().version !== CACHE_VERSION) cache.set({ version: CACHE_VERSION, files: {}, books: [] });
    const lib = new Library(dataDir, settings, library, cache);
    lib.setBooks(cache.get().books.filter((b) => library.get().folders.some((f) => f.id === b.folderId)));
    return lib;
  }

  // ---------------------------------------------------------------- queries

  snapshot(): LibrarySnapshot {
    const data = this.libraryStore.get();
    return {
      folders: data.folders,
      books: this.books,
      states: data.states,
      settings: this.settingsStore.get(),
      scanning: this.scanning,
    };
  }

  settings(): Settings {
    return this.settingsStore.get();
  }

  book(id: string): Book | undefined {
    return this.books.find((b) => b.id === id);
  }

  findBookByFile(file: string): Book | undefined {
    const resolved = path.resolve(file).toLowerCase();
    return this.books.find((b) => b.tracks.some((t) => path.resolve(t.path).toLowerCase() === resolved));
  }

  /** Only files that belong to the library may be served to the renderer. */
  isAllowed(file: string): boolean {
    return this.allowed.has(path.resolve(file).toLowerCase());
  }

  // ---------------------------------------------------------------- mutations

  async addFolder(folderPath: string, kind: LibraryFolderKind): Promise<LibraryFolder> {
    const resolved = path.resolve(folderPath);
    const existing = this.libraryStore.get().folders.find((f) => path.resolve(f.path).toLowerCase() === resolved.toLowerCase());
    if (existing) {
      if (existing.kind !== kind) await this.setFolderKind(existing.id, kind);
      return existing;
    }
    const folder: LibraryFolder = { id: randomUUID(), path: resolved, kind };
    this.libraryStore.update((d) => {
      d.folders.push(folder);
    });
    this.emit();
    void this.rescan();
    return folder;
  }

  /** Adds dropped / opened paths, guessing how each one should be interpreted. */
  async addPaths(paths: string[]): Promise<LibraryFolder[]> {
    const added: LibraryFolder[] = [];
    for (const p of paths) {
      const kind = await guessKind(p);
      if (kind) added.push(await this.addFolder(p, kind));
    }
    return added;
  }

  async removeFolder(folderId: string): Promise<void> {
    this.libraryStore.update((d) => {
      d.folders = d.folders.filter((f) => f.id !== folderId);
    });
    this.setBooks(this.books.filter((b) => b.folderId !== folderId));
    this.persistBooks();
    this.emit();
    this.watchFolders();
  }

  async setFolderKind(folderId: string, kind: LibraryFolderKind): Promise<void> {
    this.libraryStore.update((d) => {
      const folder = d.folders.find((f) => f.id === folderId);
      if (folder) folder.kind = kind;
    });
    this.emit();
    await this.rescan();
  }

  updateBookState(bookId: string, patch: Partial<BookState>): void {
    this.libraryStore.update((d) => {
      const current = d.states[bookId] ?? defaultBookState(this.settings().defaultSpeed);
      d.states[bookId] = { ...current, ...patch };
    });
  }

  resetBook(bookId: string): void {
    this.libraryStore.update((d) => {
      const current = d.states[bookId] ?? defaultBookState(this.settings().defaultSpeed);
      d.states[bookId] = { ...current, trackIndex: 0, positionMs: 0, completed: false };
    });
    this.emit();
  }

  async setCustomCover(bookId: string, imagePath: string | null): Promise<void> {
    this.libraryStore.update((d) => {
      const current = d.states[bookId] ?? defaultBookState(this.settings().defaultSpeed);
      const next = { ...current };
      if (imagePath) next.customCoverPath = imagePath;
      else delete next.customCoverPath;
      d.states[bookId] = next;
    });
    const book = this.book(bookId);
    if (book) {
      const coverPath = await this.resolveCover(book.root, book.tracks[0]?.path, bookId, !book.tracks.length || isAudioFile(book.root));
      const updated = { ...book, coverUrl: coverPath ? coverUrl(coverPath) : null };
      this.setBooks(this.books.map((b) => (b.id === bookId ? updated : b)));
      this.persistBooks();
    }
    this.emit();
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.settingsStore.update((s) => ({ ...s, ...patch }));
    return this.settingsStore.get();
  }

  async flush(): Promise<void> {
    await Promise.all([this.settingsStore.flush(), this.libraryStore.flush(), this.cacheStore.flush()]);
  }

  // ---------------------------------------------------------------- scanning

  /** Scans all folders. Calls during a scan queue one more pass and resolve when it is done. */
  rescan(): Promise<void> {
    if (this.scanPromise) {
      this.rescanRequested = true;
      return this.scanPromise;
    }
    this.scanning = true;
    this.emit();
    this.scanPromise = (async () => {
      try {
        do {
          this.rescanRequested = false;
          await this.scanOnce();
        } while (this.rescanRequested);
      } catch (err) {
        console.error('Library scan failed', err);
      } finally {
        this.scanning = false;
        this.scanPromise = null;
        this.onProgress({ done: 0, total: 0, current: null });
        this.emit();
        this.watchFolders();
      }
    })();
    return this.scanPromise;
  }

  private async scanOnce(): Promise<void> {
    const folders = this.libraryStore.get().folders;
    const candidates: BookCandidate[] = [];
    const seen = new Set<string>();
    for (const folder of folders) {
      for (const candidate of await findCandidates(folder)) {
        const id = bookIdFor(candidate.root);
        if (seen.has(id)) continue;
        seen.add(id);
        candidates.push(candidate);
      }
    }

    const cache = this.cacheStore.get().files;
    const total = candidates.reduce((n, c) => n + c.files.length, 0);
    let done = 0;
    const freshCache: Record<string, FileMeta> = {};

    const books = await mapLimit(candidates, 3, async (candidate) => {
      const files: string[] = [];
      const metas: FileMeta[] = [];
      for (const file of candidate.files) {
        let meta: FileMeta | undefined = cache[file];
        try {
          const stat = await fs.stat(file);
          if (!meta || meta.size !== stat.size || Math.abs(meta.mtimeMs - stat.mtimeMs) > 1) {
            this.onProgress({ done, total, current: path.basename(file) });
            meta = await readFileMeta(file);
          }
        } catch {
          meta = undefined; // the file disappeared while scanning
        }
        done++;
        if (meta) {
          freshCache[file] = meta;
          files.push(file);
          metas.push(meta);
        }
      }
      return this.buildBook({ ...candidate, files }, metas);
    });

    this.cacheStore.set({ version: CACHE_VERSION, files: freshCache, books: [] });
    this.setBooks(books.filter((b): b is Book => b !== null));
    this.persistBooks();
    this.emit();
  }

  private async buildBook(candidate: BookCandidate, metas: FileMeta[]): Promise<Book | null> {
    if (metas.length !== candidate.files.length || metas.length === 0) return null;
    const id = bookIdFor(candidate.root);
    const titles = trackTitles(candidate.files, metas);
    const tracks = candidate.files.map((file, i) => ({
      path: file,
      url: mediaUrl(file),
      title: titles[i],
      durationMs: metas[i].durationMs,
      marks: metas[i].marks,
    }));
    const data = this.libraryStore.get();
    if (!data.addedAt[id]) {
      this.libraryStore.update((d) => {
        d.addedAt[id] = Date.now();
      });
    }
    const coverPath = await this.resolveCover(candidate.root, candidate.files[0], id, candidate.isFile);
    return {
      id,
      folderId: candidate.folderId,
      root: candidate.root,
      name: bookName(candidate, metas),
      author: candidate.author ?? metas.find((m) => m.artist)?.artist ?? null,
      tracks,
      durationMs: tracks.reduce((n, t) => n + t.durationMs, 0),
      coverUrl: coverPath ? coverUrl(coverPath) : null,
      addedAt: data.addedAt[id] ?? Date.now(),
    };
  }

  private async resolveCover(root: string, firstFile: string | undefined, bookId: string, isFile: boolean): Promise<string | null> {
    const custom = this.libraryStore.get().states[bookId]?.customCoverPath;
    if (custom) {
      try {
        await fs.access(custom);
        return custom;
      } catch {
        /* fall through */
      }
    }
    if (!isFile) {
      const folderCover = await findFolderCover(root);
      if (folderCover) return folderCover;
      // Covers often live next to the first file in a nested "CD1" folder.
      if (firstFile && path.dirname(firstFile) !== root) {
        const nested = await findFolderCover(path.dirname(firstFile));
        if (nested) return nested;
      }
    }
    if (!firstFile) return null;
    const coversDir = path.join(this.dataDir, 'covers');
    let stamp = 0;
    try {
      stamp = Math.round((await fs.stat(firstFile)).mtimeMs);
    } catch {
      return null;
    }
    for (const ext of ['.jpg', '.png', '.webp']) {
      const cached = path.join(coversDir, `${bookId}-${stamp}${ext}`);
      try {
        await fs.access(cached);
        return cached;
      } catch {
        /* not cached yet */
      }
    }
    const embedded = await readEmbeddedCover(firstFile);
    if (!embedded) return null;
    await fs.mkdir(coversDir, { recursive: true });
    // Remove stale covers of this book.
    for (const name of await fs.readdir(coversDir).catch(() => [] as string[])) {
      if (name.startsWith(`${bookId}-`)) await fs.rm(path.join(coversDir, name), { force: true });
    }
    const target = path.join(coversDir, `${bookId}-${stamp}${embedded.ext}`);
    await fs.writeFile(target, embedded.data);
    return target;
  }

  private setBooks(books: Book[]) {
    this.books = books;
    this.allowed = new Set();
    for (const book of books) {
      for (const track of book.tracks) this.allowed.add(path.resolve(track.path).toLowerCase());
      const cover = book.coverUrl ? pathFromMediaUrl(new URL(book.coverUrl)) : null;
      if (cover) this.allowed.add(path.resolve(cover).toLowerCase());
    }
  }

  private persistBooks() {
    this.cacheStore.update((c) => {
      c.books = this.books;
    });
  }

  private emit() {
    this.onChange(this.snapshot());
  }

  // ---------------------------------------------------------------- watching

  /** Rescan automatically when files are added to or removed from library folders. */
  private watchFolders() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const folder of this.libraryStore.get().folders) {
      if (folder.kind === 'file') continue;
      try {
        const watcher = watch(folder.path, { recursive: true, persistent: false }, (_event, filename) => {
          if (filename && !isAudioFile(String(filename)) && path.extname(String(filename))) return;
          if (this.watchTimer) clearTimeout(this.watchTimer);
          this.watchTimer = setTimeout(() => void this.rescan(), 3000);
        });
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch {
        /* folder missing or recursive watching unsupported */
      }
    }
  }

  dispose() {
    for (const w of this.watchers) w.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
  }
}

function coverUrl(file: string): string {
  return mediaUrl(file);
}

/** Decides how a dropped or opened path should be added to the library. */
export async function guessKind(p: string): Promise<LibraryFolderKind | null> {
  let stat;
  try {
    stat = await fs.stat(p);
  } catch {
    return null;
  }
  if (stat.isFile()) return isAudioFile(p) ? 'file' : null;
  if (!stat.isDirectory()) return null;
  const entries = await fs.readdir(p, { withFileTypes: true });
  const directAudio = entries.filter((e) => e.isFile() && isAudioFile(e.name)).length;
  let subfoldersWithAudio = 0;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && (await audioFilesIn(path.join(p, e.name))).length > 0) {
      subfoldersWithAudio++;
    }
  }
  // A folder of loose files ("Book/01.mp3, 02.mp3") or of CD folders ("Book/CD1, CD2") is one book.
  if (directAudio > 0 && subfoldersWithAudio === 0) return directAudio === 1 ? 'library' : 'single';
  if (directAudio === 0 && subfoldersWithAudio > 0) {
    const cdLike = entries.filter((e) => e.isDirectory()).every((e) => /^(cd|disc|disk|part)\s*\d+$/i.test(e.name));
    return cdLike ? 'single' : 'library';
  }
  return 'library';
}
