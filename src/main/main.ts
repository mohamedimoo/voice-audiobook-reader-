import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  protocol,
  shell,
  Tray,
  type NativeImage,
  type ThumbarButton,
} from 'electron';
import { createReadStream, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import type { BookState, LibraryFolderKind, NowPlaying, PlayerCommand, Settings } from '../shared/types';
import { Library, pathFromMediaUrl } from './library';
import { isAudioFile } from './scanner';
import { JsonStore } from './store';

const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSETS_DIR = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(__dirname, '..', 'build', 'assets');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mka': 'audio/x-matroska',
};

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'voice',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);

let library: Library;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let nowPlaying: NowPlaying = { bookId: null, title: null, playing: false };
let powerBlockerId: number | null = null;
const pendingOpenFiles: string[] = [];

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

// Allows running isolated profiles (portable installs, testing).
if (process.env.VOICE_USER_DATA) app.setPath('userData', path.resolve(process.env.VOICE_USER_DATA));

// ------------------------------------------------------------------ single instance & file opening

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    void openFiles(audioArgs(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  pendingOpenFiles.push(...audioArgs(process.argv));
  void start();
}

function audioArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith('-') && isAudioFile(a));
}

async function openFiles(files: string[]) {
  if (!library || files.length === 0) {
    pendingOpenFiles.push(...files);
    return;
  }
  await library.addPaths(files);
  await library.rescan();
  const book = library.findBookByFile(files[0]);
  if (book) mainWindow?.webContents.send('open-book', book.id);
}

// ------------------------------------------------------------------ protocol

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

async function serveFile(file: string, request: Request): Promise<Response> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const headers: Record<string, string> = {
    'Content-Type': mimeFor(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const range = request.headers.get('range');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] || match[2])) {
    let start: number;
    let end: number;
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

function registerProtocol() {
  protocol.handle('voice', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const mediaPath = pathFromMediaUrl(url);
    if (mediaPath !== null) {
      if (!library.isAllowed(mediaPath)) return new Response('Forbidden', { status: 403 });
      return serveFile(mediaPath, request);
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const file = path.normalize(path.join(RENDERER_DIR, relative));
    if (!file.startsWith(RENDERER_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
    return serveFile(file, request);
  });
}

// ------------------------------------------------------------------ window

async function createWindow(windowStore: JsonStore<WindowState>) {
  const state = windowStore.get();
  const settings = library.settings();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: 'Voice Desktop',
    icon: icon('icon.png'),
    backgroundColor: settings.theme === 'light' ? '#f6f4f9' : '#16141c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  if (state.maximized) mainWindow.maximize();

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  const saveBounds = () => {
    if (!mainWindow || mainWindow.isMinimized()) return;
    const maximized = mainWindow.isMaximized();
    const bounds = maximized ? windowStore.get() : mainWindow.getBounds();
    windowStore.set({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized });
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('close', (event) => {
    if (!quitting && library.settings().minimizeToTray) {
      event.preventDefault();
      mainWindow?.hide();
      ensureTray();
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open links in the default browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('voice://app/')) event.preventDefault();
  });
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && !app.isPackaged) mainWindow?.webContents.toggleDevTools();
  });

  await mainWindow.loadURL('voice://app/index.html');
  updateTaskbar();
}

function send(channel: string, ...args: unknown[]) {
  mainWindow?.webContents.send(channel, ...args);
}

function command(cmd: PlayerCommand) {
  send('command', cmd);
}

// ------------------------------------------------------------------ tray & taskbar

const iconCache = new Map<string, NativeImage>();
function icon(name: string): NativeImage {
  let image = iconCache.get(name);
  if (!image) {
    image = nativeImage.createFromPath(path.join(ASSETS_DIR, name));
    iconCache.set(name, image);
  }
  return image;
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(icon('tray.png'));
  tray.setToolTip('Voice Desktop');
  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(nowPlaying.title ? `Voice Desktop — ${nowPlaying.title}` : 'Voice Desktop');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: nowPlaying.title ?? 'Nothing playing', enabled: false },
      { type: 'separator' },
      { label: nowPlaying.playing ? 'Pause' : 'Play', enabled: !!nowPlaying.bookId, click: () => command('toggle') },
      { label: 'Rewind', enabled: !!nowPlaying.bookId, click: () => command('rewind') },
      { label: 'Fast forward', enabled: !!nowPlaying.bookId, click: () => command('forward') },
      { type: 'separator' },
      { label: 'Show Voice Desktop', click: () => (mainWindow?.show(), mainWindow?.focus()) },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function updateTaskbar() {
  if (!mainWindow || process.platform !== 'win32') return;
  const enabled = !!nowPlaying.bookId;
  const flags: ThumbarButton['flags'] = enabled ? [] : ['disabled'];
  mainWindow.setThumbarButtons([
    { tooltip: 'Previous chapter', icon: icon('thumb-previous.png'), flags, click: () => command('previous') },
    { tooltip: 'Rewind', icon: icon('thumb-rewind.png'), flags, click: () => command('rewind') },
    nowPlaying.playing
      ? { tooltip: 'Pause', icon: icon('thumb-pause.png'), flags, click: () => command('pause') }
      : { tooltip: 'Play', icon: icon('thumb-play.png'), flags, click: () => command('play') },
    { tooltip: 'Fast forward', icon: icon('thumb-forward.png'), flags, click: () => command('forward') },
    { tooltip: 'Next chapter', icon: icon('thumb-next.png'), flags, click: () => command('next') },
  ]);
}

function updatePowerBlocker() {
  // Keep the system from suspending the app while a book is playing.
  if (nowPlaying.playing && powerBlockerId === null) {
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!nowPlaying.playing && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('snapshot', () => library.snapshot());

  ipcMain.handle('add-folder', async (_e, kind: LibraryFolderKind) => {
    const isFile = kind === 'file';
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: isFile ? 'Add audiobook files' : 'Add audiobook folder',
      properties: isFile ? ['openFile', 'multiSelections'] : ['openDirectory'],
      filters: isFile ? [{ name: 'Audio', extensions: ['mp3', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'webm', 'mka'] }] : undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    let first = null;
    for (const p of result.filePaths) {
      const folder = await library.addFolder(p, kind);
      first ??= folder;
    }
    return first;
  });

  ipcMain.handle('add-paths', (_e, paths: string[]) => library.addPaths(paths.filter((p) => typeof p === 'string')));
  ipcMain.handle('remove-folder', (_e, id: string) => library.removeFolder(id));
  ipcMain.handle('set-folder-kind', (_e, id: string, kind: LibraryFolderKind) => library.setFolderKind(id, kind));
  ipcMain.handle('rescan', () => library.rescan());
  ipcMain.handle('update-book-state', (_e, id: string, patch: Partial<BookState>) => library.updateBookState(id, patch));
  ipcMain.handle('reset-book', (_e, id: string) => library.resetBook(id));

  ipcMain.handle('pick-cover', async (_e, id: string) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose a cover image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }],
    });
    if (result.canceled || !result.filePaths[0]) return;
    await library.setCustomCover(id, result.filePaths[0]);
  });
  ipcMain.handle('clear-cover', (_e, id: string) => library.setCustomCover(id, null));

  ipcMain.handle('show-in-folder', (_e, id: string) => {
    const book = library.book(id);
    if (!book) return;
    if (isAudioFile(book.root)) shell.showItemInFolder(book.root);
    else void shell.openPath(book.root);
  });

  ipcMain.handle('update-settings', (_e, patch: Partial<Settings>) => {
    const settings = library.updateSettings(patch);
    if (settings.minimizeToTray) ensureTray();
    else if (tray) {
      tray.destroy();
      tray = null;
    }
    return settings;
  });

  ipcMain.on('now-playing', (_e, info: NowPlaying) => {
    nowPlaying = info;
    mainWindow?.setTitle(info.title ? `${info.title} — Voice Desktop` : 'Voice Desktop');
    updateTaskbar();
    updateTray();
    updatePowerBlocker();
  });
}

// ------------------------------------------------------------------ lifecycle

async function start() {
  app.setAppUserModelId('io.github.voicedesktop.app');
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const dataDir = app.getPath('userData');
  library = await Library.open(dataDir);
  const windowStore = await JsonStore.open<WindowState>(path.join(dataDir, 'window.json'), () => ({
    width: 1180,
    height: 780,
    maximized: false,
  }));

  library.onChange = (snapshot) => send('library-changed', snapshot);
  library.onProgress = (progress) => send('scan-progress', progress);

  registerProtocol();
  registerIpc();
  if (library.settings().minimizeToTray) ensureTray();
  await createWindow(windowStore);

  const toOpen = pendingOpenFiles.splice(0);
  if (toOpen.length) await openFiles(toOpen);
  else void library.rescan();

  app.on('activate', () => {
    if (!mainWindow) void createWindow(windowStore);
  });

  app.on('before-quit', async (event) => {
    quitting = true;
    if (flushed) return;
    event.preventDefault();
    send('flush');
    // Give the renderer a moment to report its last position, then persist everything.
    await new Promise((r) => setTimeout(r, 150));
    library.dispose();
    await Promise.all([library.flush(), windowStore.flush()]);
    flushed = true;
    app.quit();
  });
}

let flushed = false;

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !(library?.settings().minimizeToTray && tray)) app.quit();
});
