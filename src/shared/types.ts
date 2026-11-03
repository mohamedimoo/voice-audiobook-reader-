/**
 * Types shared between the main process, the preload bridge and the renderer.
 */

/**
 * How a library folder is interpreted when scanning:
 * - `library`: every direct child (audio file or folder) is a separate book.
 * - `authors`: every direct child folder is an author; each of their children is a book.
 * - `single`: the whole folder (recursively) is one book.
 * - `file`: a single audio file that is one book (e.g. an opened .m4b).
 */
export type LibraryFolderKind = 'library' | 'authors' | 'single' | 'file';

export interface LibraryFolder {
  id: string;
  path: string;
  kind: LibraryFolderKind;
}

/** A chapter mark embedded inside a single audio file (e.g. m4b chapters). */
export interface ChapterMark {
  title: string;
  startMs: number;
}

export interface Track {
  path: string;
  /** URL the renderer can load the file from. */
  url: string;
  title: string;
  durationMs: number;
  marks: ChapterMark[];
}

export interface Book {
  id: string;
  folderId: string;
  /** The folder or file this book was built from. */
  root: string;
  name: string;
  author: string | null;
  tracks: Track[];
  durationMs: number;
  coverUrl: string | null;
  addedAt: number;
}

export interface Bookmark {
  id: string;
  title: string;
  trackIndex: number;
  positionMs: number;
  createdAt: number;
}

export interface BookState {
  trackIndex: number;
  positionMs: number;
  speed: number;
  skipSilence: boolean;
  /** Gain boost in decibels (0 = off). */
  gainDb: number;
  lastPlayedAt: number;
  completed: boolean;
  bookmarks: Bookmark[];
  customCoverPath?: string;
}

export interface Settings {
  theme: 'system' | 'dark' | 'light';
  skipBackSeconds: number;
  skipForwardSeconds: number;
  autoRewindSeconds: number;
  sleepTimerMinutes: number;
  /** Fade the volume out during the last seconds of the sleep timer. */
  sleepFadeOut: boolean;
  libraryLayout: 'grid' | 'list';
  librarySort: 'recent' | 'name' | 'author' | 'added' | 'progress';
  defaultSpeed: number;
  lastBookId: string | null;
  minimizeToTray: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  skipBackSeconds: 20,
  skipForwardSeconds: 30,
  autoRewindSeconds: 2,
  sleepTimerMinutes: 20,
  sleepFadeOut: true,
  libraryLayout: 'grid',
  librarySort: 'recent',
  defaultSpeed: 1,
  lastBookId: null,
  minimizeToTray: false,
};

export function defaultBookState(speed = 1): BookState {
  return {
    trackIndex: 0,
    positionMs: 0,
    speed,
    skipSilence: false,
    gainDb: 0,
    lastPlayedAt: 0,
    completed: false,
    bookmarks: [],
  };
}

export interface LibrarySnapshot {
  folders: LibraryFolder[];
  books: Book[];
  states: Record<string, BookState>;
  settings: Settings;
  scanning: boolean;
}

export type ScanProgress = { done: number; total: number; current: string | null };

/** Commands the main process can send to the renderer (tray, taskbar buttons, media keys). */
export type PlayerCommand = 'toggle' | 'play' | 'pause' | 'next' | 'previous' | 'rewind' | 'forward';

/** Information the renderer reports to the main process so it can update tray & taskbar. */
export interface NowPlaying {
  bookId: string | null;
  title: string | null;
  playing: boolean;
}

/** The API exposed to the renderer through the preload script as `window.voice`. */
export interface VoiceApi {
  getSnapshot(): Promise<LibrarySnapshot>;
  addFolder(kind: LibraryFolderKind): Promise<LibraryFolder | null>;
  addPaths(paths: string[]): Promise<void>;
  removeFolder(folderId: string): Promise<void>;
  setFolderKind(folderId: string, kind: LibraryFolderKind): Promise<void>;
  rescan(): Promise<void>;
  updateBookState(bookId: string, patch: Partial<BookState>): Promise<void>;
  resetBook(bookId: string): Promise<void>;
  pickCover(bookId: string): Promise<void>;
  clearCover(bookId: string): Promise<void>;
  showInFolder(bookId: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  reportNowPlaying(info: NowPlaying): void;
  pathForFile(file: File): string;
  onLibraryChanged(cb: (snapshot: LibrarySnapshot) => void): () => void;
  onScanProgress(cb: (progress: ScanProgress) => void): () => void;
  onCommand(cb: (command: PlayerCommand) => void): () => void;
  onOpenBook(cb: (bookId: string) => void): () => void;
  /** The app is about to quit: persist anything pending. */
  onFlush(cb: () => void): () => void;
}
