import { bookPositionMs, formatDuration, formatTime, naturalCompare } from '../shared/chapters';
import {
  defaultBookState,
  type Book,
  type Bookmark,
  type BookState,
  type LibraryFolderKind,
  type LibrarySnapshot,
  type PlayerCommand,
  type Settings,
  type VoiceApi,
} from '../shared/types';
import { $, clear, h, replaceChildren } from './dom';
import { icon, type IconName } from './icons';
import { Player } from './player';

declare global {
  interface Window {
    voice: VoiceApi;
  }
}

const api = window.voice;

let snap: LibrarySnapshot = {
  folders: [],
  books: [],
  states: {},
  settings: {} as Settings,
  scanning: false,
};
let view: 'library' | 'player' = 'library';
let search = '';
let panel: null | 'chapters' | 'bookmarks' = null;
let scanText = '';

const player = new Player({
  autoRewindMs: () => (snap.settings.autoRewindSeconds ?? 0) * 1000,
  sleepFadeOut: () => snap.settings.sleepFadeOut !== false,
  persist: (bookId, patch) => saveState(bookId, patch),
});

// ==================================================================== state helpers

function stateOf(bookId: string): BookState {
  return snap.states[bookId] ?? defaultBookState(snap.settings.defaultSpeed ?? 1);
}

function saveState(bookId: string, patch: Partial<BookState>) {
  snap.states[bookId] = { ...stateOf(bookId), ...patch };
  void api.updateBookState(bookId, patch);
  if ('completed' in patch || 'lastPlayedAt' in patch) scheduleLibraryRender();
}

async function updateSettings(patch: Partial<Settings>) {
  snap.settings = { ...snap.settings, ...patch };
  applyTheme();
  snap.settings = await api.updateSettings(patch);
}

function bookProgress(book: Book): number {
  const state = stateOf(book.id);
  if (state.completed) return 1;
  if (!book.durationMs) return 0;
  const pos = player.book?.id === book.id ? player.bookPositionMs : bookPositionMs(book, state.trackIndex, state.positionMs);
  return Math.min(1, pos / book.durationMs);
}

function isStarted(book: Book): boolean {
  if (player.book?.id === book.id && player.bookPositionMs > 0 && !stateOf(book.id).completed) return true;
  const s = stateOf(book.id);
  return !s.completed && (s.positionMs > 0 || s.trackIndex > 0 || s.lastPlayedAt > 0);
}

function remainingText(book: Book): string {
  const state = stateOf(book.id);
  if (state.completed) return 'Finished';
  const progress = bookProgress(book);
  if (progress === 0) return formatDuration(book.durationMs);
  const left = (book.durationMs * (1 - progress)) / (state.speed || 1);
  return `${formatDuration(left)} left`;
}

// ==================================================================== theme

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = snap.settings.theme ?? 'system';
  const resolved = theme === 'system' ? (darkQuery.matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = resolved;
}
darkQuery.addEventListener('change', applyTheme);

// ==================================================================== covers

function hashHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

function coverEl(book: Book, className = ''): HTMLElement {
  const el = h('div', { class: `cover ${className}` });
  const placeholder = () => {
    const hue = hashHue(book.name);
    return h(
      'div',
      {
        class: 'cover-placeholder',
        style: `background: linear-gradient(145deg, hsl(${hue} 62% 62%), hsl(${(hue + 35) % 360} 55% 38%))`,
      },
      h('div', { class: 'ph-title' }, book.name),
      book.author ? h('div', { class: 'ph-author' }, book.author) : null,
    );
  };
  if (book.coverUrl) {
    const img = h('img', { src: book.coverUrl, alt: '', draggable: false, loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
    el.appendChild(img);
  } else {
    el.appendChild(placeholder());
  }
  return el;
}

// ==================================================================== layers: popovers, menus, dialogs, toasts

const layer = $('#layer');
let closeCurrentPopover: (() => void) | null = null;

function closePopover() {
  closeCurrentPopover?.();
  closeCurrentPopover = null;
}

function openPopover(content: HTMLElement, at: HTMLElement | { x: number; y: number }, align: 'above' | 'below' = 'below') {
  closePopover();
  const pop = h('div', { class: 'popover', role: 'menu' }, content);
  layer.appendChild(pop);
  const { width, height } = pop.getBoundingClientRect();
  let x: number;
  let y: number;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left + r.width / 2 - width / 2;
    y = align === 'above' ? r.top - height - 8 : r.bottom + 8;
    if (y + height > window.innerHeight - 8) y = r.top - height - 8;
    if (y < 8) y = r.bottom + 8;
  } else {
    x = at.x;
    y = at.y;
    if (y + height > window.innerHeight - 8) y = Math.max(8, at.y - height);
  }
  x = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  pop.style.left = `${x}px`;
  pop.style.top = `${y}px`;

  const onDown = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node) && !(at instanceof HTMLElement && at.contains(e.target as Node))) closePopover();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closePopover();
    }
  };
  setTimeout(() => document.addEventListener('mousedown', onDown), 0);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closePopover, { once: true });
  closeCurrentPopover = () => {
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey, true);
    pop.remove();
  };
  (pop.querySelector('button, input') as HTMLElement | null)?.focus({ preventScroll: true });
  return pop;
}

interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  selected?: boolean;
  danger?: boolean;
  action: () => void;
}
type MenuEntry = MenuItem | 'separator' | { heading: string };

function menu(entries: MenuEntry[]): HTMLElement {
  return h(
    'div',
    null,
    entries.map((entry) => {
      if (entry === 'separator') return h('div', { class: 'menu-sep' });
      if ('heading' in entry) return h('div', { class: 'menu-label' }, entry.heading);
      return h(
        'button',
        {
          class: `menu-item${entry.selected ? ' selected' : ''}${entry.danger ? ' danger' : ''}`,
          role: 'menuitem',
          onclick: () => {
            closePopover();
            entry.action();
          },
        },
        entry.icon ? icon(entry.icon) : null,
        entry.label,
        entry.hint ? h('span', { class: 'menu-hint' }, entry.hint) : null,
      );
    }),
  );
}

let dialogOpen = 0;
function openDialog(options: {
  title: string;
  body: HTMLElement | HTMLElement[];
  footer?: HTMLElement[];
  small?: boolean;
  onClose?: () => void;
}): () => void {
  closePopover();
  dialogOpen++;
  const close = () => {
    dialogOpen = Math.max(0, dialogOpen - 1);
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    options.onClose?.();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !closeCurrentPopover) {
      e.stopPropagation();
      close();
    }
  };
  const backdrop = h(
    'div',
    { class: 'backdrop', onmousedown: (e: MouseEvent) => e.target === backdrop && close() },
    h(
      'div',
      { class: `dialog${options.small ? ' small' : ''}`, role: 'dialog', 'aria-label': options.title },
      h(
        'div',
        { class: 'dialog-head' },
        h('h2', null, options.title),
        h('button', { class: 'icon-btn', title: 'Close', onclick: close }, icon('close')),
      ),
      h('div', { class: 'dialog-body' }, options.body),
      options.footer ? h('div', { class: 'dialog-foot' }, options.footer) : null,
    ),
  );
  document.addEventListener('keydown', onKey, true);
  layer.appendChild(backdrop);
  return close;
}

function prompt(title: string, initial: string, confirmLabel = 'Save'): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = h('input', { class: 'text-input', value: initial, spellcheck: false });
    const submit = () => {
      result = input.value.trim() || initial;
      close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    const close = openDialog({
      title,
      small: true,
      body: input,
      footer: [
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: submit }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

const toastEl = $('#toast');
let toastTimer: number | null = null;
function toast(message: string) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 2600);
}

// ==================================================================== adding books

const FOLDER_KINDS: { kind: LibraryFolderKind; label: string; desc: string; icon: IconName }[] = [
  { kind: 'library', label: 'Library folder', desc: 'Every subfolder or file inside is a book', icon: 'folder' },
  { kind: 'authors', label: 'Authors folder', desc: 'Author folders that contain book folders', icon: 'folder' },
  { kind: 'single', label: 'Single book folder', desc: 'The whole folder is one book', icon: 'book' },
  { kind: 'file', label: 'Audio files', desc: 'Each selected file is a book', icon: 'headphones' },
];

function kindLabel(kind: LibraryFolderKind) {
  return FOLDER_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

async function addFolder(kind: LibraryFolderKind) {
  const folder = await api.addFolder(kind);
  if (folder) toast('Added — scanning your audiobooks…');
}

function addMenu(anchor: HTMLElement) {
  openPopover(
    menu([
      { heading: 'Add to library' },
      ...FOLDER_KINDS.map((k) => ({ label: k.label, icon: k.icon, hint: k.desc, action: () => void addFolder(k.kind) })),
    ]),
    anchor,
  );
}

// ==================================================================== sidebar & top bar

type Filter = 'all' | 'listening' | 'new' | 'finished';
let filter: Filter = 'all';

const FILTERS: { id: Filter; label: string; icon: IconName; matches: (b: Book) => boolean }[] = [
  { id: 'all', label: 'Library', icon: 'library', matches: () => true },
  { id: 'listening', label: 'Continue listening', icon: 'clock', matches: (b) => isStarted(b) },
  { id: 'new', label: 'Not started', icon: 'sparkle', matches: (b) => !isStarted(b) && !stateOf(b.id).completed },
  { id: 'finished', label: 'Finished', icon: 'checkCircle', matches: (b) => stateOf(b.id).completed },
];

const sidebar = $('#sidebar');
const navList = h('nav', { class: 'nav' });
const sidebarStatus = h('div', { class: 'sidebar-status' });
const addButton: HTMLButtonElement = h(
  'button',
  { class: 'btn primary add-btn', title: 'Add books', onclick: () => addMenu(addButton) },
  icon('add'),
  h('span', { class: 'btn-label' }, 'Add books'),
);

function buildSidebar() {
  replaceChildren(
    sidebar,
    h(
      'div',
      { class: 'brand' },
      h('img', { class: 'brand-logo', src: 'logo.svg', alt: '', draggable: false }),
      h('div', { class: 'brand-text' }, h('div', { class: 'brand-name' }, 'Voice'), h('div', { class: 'brand-sub' }, 'Audiobook player')),
    ),
    addButton,
    h('div', { class: 'nav-label' }, 'Browse'),
    navList,
    h('div', { class: 'spacer' }),
    sidebarStatus,
    h(
      'nav',
      { class: 'nav' },
      h('button', { class: 'nav-item', title: 'Rescan library', onclick: () => void api.rescan() }, icon('refresh'), h('span', { class: 'nav-text' }, 'Rescan library')),
      h('button', { class: 'nav-item', title: 'Settings', onclick: openSettings }, icon('settings'), h('span', { class: 'nav-text' }, 'Settings')),
    ),
  );
}

function renderSidebar() {
  replaceChildren(
    navList,
    FILTERS.map((f) => {
      const count = snap.books.filter(f.matches).length;
      return h(
        'button',
        {
          class: `nav-item${view === 'library' && filter === f.id ? ' active' : ''}`,
          title: f.label,
          onclick: () => {
            filter = f.id;
            if (view !== 'library') showLibrary();
            else renderLibrary();
            renderSidebar();
            renderTopbar();
          },
        },
        icon(f.icon),
        h('span', { class: 'nav-text' }, f.label),
        count ? h('span', { class: 'nav-count' }, String(count)) : null,
      );
    }),
  );
  sidebarStatus.hidden = !snap.scanning;
  replaceChildren(sidebarStatus, h('div', { class: 'spinner' }), h('span', null, scanText || 'Scanning library…'));
}

const topbar = $('#topbar');
const pageTitle = h('h1', { class: 'page-title' });
const pageSub = h('div', { class: 'page-sub' });
const searchInput = h('input', {
  type: 'search',
  placeholder: 'Search',
  spellcheck: false,
  oninput: () => {
    search = searchInput.value.trim().toLowerCase();
    if (view !== 'library') showLibrary();
    renderLibrary();
    renderTopbar();
  },
});
const sortSelect = h(
  'select',
  {
    class: 'select',
    title: 'Sort books',
    onchange: () => void updateSettings({ librarySort: sortSelect.value as Settings['librarySort'] }).then(renderLibrary),
  },
  h('option', { value: 'recent' }, 'Recently played'),
  h('option', { value: 'name' }, 'Title'),
  h('option', { value: 'author' }, 'Author'),
  h('option', { value: 'added' }, 'Recently added'),
  h('option', { value: 'progress' }, 'Progress'),
);
const gridButton = h('button', { class: 'seg-btn', title: 'Grid', onclick: () => setLayout('grid') }, icon('grid'));
const listButton = h('button', { class: 'seg-btn', title: 'List', onclick: () => setLayout('list') }, icon('list'));

function setLayout(layout: Settings['libraryLayout']) {
  void updateSettings({ libraryLayout: layout }).then(() => {
    renderTopbar();
    renderLibrary();
  });
}

function buildTopbar() {
  replaceChildren(
    topbar,
    h('div', { class: 'page-head' }, pageTitle, pageSub),
    h('div', { class: 'spacer' }),
    h('label', { class: 'search' }, icon('search'), searchInput, h('kbd', { class: 'search-kbd' }, 'Ctrl F')),
    sortSelect,
    h('div', { class: 'segmented', role: 'group', 'aria-label': 'Layout' }, gridButton, listButton),
  );
}

function renderTopbar() {
  const current = FILTERS.find((f) => f.id === filter)!;
  pageTitle.textContent = search ? 'Search' : current.label;
  const count = search ? null : snap.books.filter(current.matches).length;
  pageSub.textContent = search
    ? `Results for “${searchInput.value.trim()}”`
    : snap.books.length === 0
      ? 'Add a folder to get started'
      : `${count} book${count === 1 ? '' : 's'}`;
  sortSelect.value = snap.settings.librarySort ?? 'recent';
  const grid = snap.settings.libraryLayout !== 'list';
  gridButton.classList.toggle('active', grid);
  listButton.classList.toggle('active', !grid);
  const hasBooks = snap.books.length > 0;
  for (const el of [sortSelect, gridButton.parentElement!, searchInput.parentElement!]) (el as HTMLElement).hidden = !hasBooks;
  renderSidebar();
}

// ==================================================================== library view

const libraryView = $('#library-view');
let libraryRenderPending = false;
function scheduleLibraryRender() {
  if (libraryRenderPending) return;
  libraryRenderPending = true;
  requestAnimationFrame(() => {
    libraryRenderPending = false;
    if (view === 'library') renderLibrary();
    renderSidebar();
  });
}

function sortBooks(books: Book[]): Book[] {
  const sort = snap.settings.librarySort ?? 'recent';
  const byName = (a: Book, b: Book) => naturalCompare(a.name, b.name);
  return [...books].sort((a, b) => {
    switch (sort) {
      case 'name':
        return byName(a, b);
      case 'author':
        return naturalCompare(a.author ?? '￿', b.author ?? '￿') || byName(a, b);
      case 'added':
        return b.addedAt - a.addedAt || byName(a, b);
      case 'progress':
        return bookProgress(b) - bookProgress(a) || byName(a, b);
      case 'recent':
      default:
        return stateOf(b.id).lastPlayedAt - stateOf(a.id).lastPlayedAt || b.addedAt - a.addedAt || byName(a, b);
    }
  });
}

function renderLibrary() {
  const books = snap.books;
  if (books.length === 0) {
    replaceChildren(libraryView, snap.folders.length && snap.scanning ? scanningState() : emptyState());
    return;
  }
  const matches = search
    ? books.filter((b) => b.name.toLowerCase().includes(search) || (b.author ?? '').toLowerCase().includes(search))
    : books;
  const sections: { title: string | null; books: Book[] }[] = [];
  if (search) {
    sections.push({ title: null, books: sortBooks(matches) });
  } else if (filter !== 'all') {
    const f = FILTERS.find((x) => x.id === filter)!;
    sections.push({ title: null, books: sortBooks(matches.filter(f.matches)) });
  } else {
    const current = matches.filter(isStarted);
    const completed = matches.filter((b) => stateOf(b.id).completed);
    const notStarted = matches.filter((b) => !isStarted(b) && !stateOf(b.id).completed);
    sections.push({ title: 'Continue listening', books: sortBooks(current) });
    sections.push({ title: current.length ? 'Not started' : 'All books', books: sortBooks(notStarted) });
    sections.push({ title: 'Finished', books: sortBooks(completed) });
  }
  const layout = snap.settings.libraryLayout === 'list' ? 'list' : 'grid';
  const scroll = libraryView.scrollTop;
  replaceChildren(
    libraryView,
    sections
      .filter((s) => s.books.length > 0)
      .map((section) =>
        h(
          'section',
          null,
          section.title
            ? h('h2', { class: 'section-title' }, section.title, h('span', { class: 'count' }, String(section.books.length)))
            : null,
          h('div', { class: layout }, section.books.map((b) => (layout === 'grid' ? bookCard(b) : bookRow(b)))),
        ),
      ),
    sections.every((sec) => sec.books.length === 0)
      ? h(
          'div',
          { class: 'empty-filter' },
          h('div', { class: 'empty-filter-icon' }, icon(search ? 'search' : FILTERS.find((f) => f.id === filter)!.icon)),
          search ? `No books match “${searchInput.value.trim()}”.` : 'Nothing here yet.',
        )
      : null,
  );
  libraryView.scrollTop = scroll;
}

function bookCard(book: Book): HTMLElement {
  const progress = bookProgress(book);
  const state = stateOf(book.id);
  const isCurrent = player.book?.id === book.id;
  const cover = coverEl(book);
  if (progress > 0 && !state.completed) {
    cover.appendChild(h('div', { class: 'cover-progress' }, h('div', { style: `width:${progress * 100}%` })));
  }
  if (state.completed) cover.appendChild(h('div', { class: 'completed-badge', title: 'Finished' }, icon('check'), 'Done'));
  const badge = h(
    'span',
    {
      class: 'play-badge',
      title: isCurrent && player.playing ? 'Pause' : 'Play',
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        quickPlay(book);
      },
    },
    icon(isCurrent && player.playing ? 'pause' : 'play'),
  );
  cover.appendChild(badge);
  return h(
    'button',
    {
      class: `card${isCurrent ? ' current' : ''}`,
      title: book.name,
      dataset: { bookId: book.id },
      onclick: () => openBook(book.id),
      oncontextmenu: (e: MouseEvent) => bookMenu(e, book),
    },
    cover,
    h(
      'div',
      { class: 'card-meta' },
      h('div', { class: 'card-title' }, book.name),
      h('div', { class: 'card-sub' }, book.author ? `${book.author} · ${remainingText(book)}` : remainingText(book)),
    ),
  );
}

function bookRow(book: Book): HTMLElement {
  const progress = bookProgress(book);
  return h(
    'button',
    {
      class: `row${player.book?.id === book.id ? ' current' : ''}`,
      dataset: { bookId: book.id },
      onclick: () => openBook(book.id),
      oncontextmenu: (e: MouseEvent) => bookMenu(e, book),
    },
    coverEl(book),
    h(
      'div',
      { class: 'row-main' },
      h('div', { class: 'row-title' }, book.name),
      h('div', { class: 'card-sub' }, book.author ?? `${book.tracks.length} file${book.tracks.length === 1 ? '' : 's'}`),
    ),
    h('div', { class: 'bar' }, h('div', { style: `width:${progress * 100}%` })),
    h('div', { class: 'row-time' }, remainingText(book)),
  );
}

function bookMenu(e: MouseEvent, book: Book) {
  e.preventDefault();
  const state = stateOf(book.id);
  openPopover(
    menu([
      { label: player.book?.id === book.id && player.playing ? 'Pause' : 'Play', icon: 'play', action: () => quickPlay(book) },
      { label: 'Open player', icon: 'headphones', action: () => openBook(book.id) },
      'separator',
      state.completed
        ? { label: 'Mark as not finished', icon: 'refresh', action: () => saveState(book.id, { completed: false }) }
        : { label: 'Mark as finished', icon: 'check', action: () => markFinished(book) },
      { label: 'Start from the beginning', icon: 'previous', action: () => restartBook(book) },
      'separator',
      { label: 'Change cover…', icon: 'edit', action: () => void api.pickCover(book.id) },
      ...(state.customCoverPath ? [{ label: 'Use original cover', icon: 'refresh' as IconName, action: () => void api.clearCover(book.id) }] : []),
      { label: 'Show in File Explorer', icon: 'folder', action: () => void api.showInFolder(book.id) },
    ]),
    { x: e.clientX, y: e.clientY },
  );
}

function markFinished(book: Book) {
  if (player.book?.id === book.id) {
    player.pause();
    player.seekTrack(0, 0);
  }
  saveState(book.id, { completed: true, trackIndex: 0, positionMs: 0 });
  renderAll();
}

function restartBook(book: Book) {
  saveState(book.id, { completed: false, trackIndex: 0, positionMs: 0 });
  if (player.book?.id === book.id) player.seekTrack(0, 0);
  renderAll();
}

function emptyState(): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-art' }, h('img', { src: 'logo.svg', alt: '', draggable: false })),
    h('h1', null, 'Your library is empty'),
    h(
      'p',
      null,
      'Add the folder where your audiobooks live. Voice remembers where you stopped in every book, ',
      'so you can pick up right where you left off. You can also drag and drop folders or files here.',
    ),
    h(
      'div',
      { class: 'empty-actions' },
      h('button', { class: 'btn primary', onclick: () => void addFolder('library') }, icon('folder'), 'Add library folder'),
      h('button', { class: 'btn', onclick: () => void addFolder('single') }, icon('book'), 'Add a single book'),
      h('button', { class: 'btn', onclick: () => void addFolder('file') }, icon('headphones'), 'Add audio files'),
    ),
    h(
      'div',
      { class: 'kinds' },
      h(
        'div',
        { class: 'kind' },
        h('strong', null, 'Library folder'),
        h('span', null, 'Each subfolder or file inside is one book.'),
        h('code', null, 'Audiobooks\\\n  The Hobbit\\\n  Dune.m4b'),
      ),
      h(
        'div',
        { class: 'kind' },
        h('strong', null, 'Authors folder'),
        h('span', null, 'Folders per author, with a folder per book.'),
        h('code', null, 'Audiobooks\\\n  Tolkien\\\n    The Hobbit\\'),
      ),
      h(
        'div',
        { class: 'kind' },
        h('strong', null, 'Single book'),
        h('span', null, 'One folder with all the files of a book.'),
        h('code', null, 'The Hobbit\\\n  01.mp3\\\n  02.mp3'),
      ),
    ),
  );
}

function scanningState(): HTMLElement {
  return h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-art' }, h('div', { class: 'spinner', style: 'width:40px;height:40px;border-width:4px' })),
    h('h1', null, 'Scanning your audiobooks…'),
    h('p', null, scanText || 'Reading files, chapters and covers. This only takes long the first time.'),
  );
}

// ==================================================================== opening & playing

function openBook(bookId: string, autoplay = false) {
  const book = snap.books.find((b) => b.id === bookId);
  if (!book) return;
  if (player.book?.id !== book.id) {
    player.load(book, stateOf(book.id));
    void updateSettings({ lastBookId: book.id });
  }
  showPlayer();
  if (autoplay) void player.play();
}

function quickPlay(book: Book) {
  if (player.book?.id === book.id) {
    player.toggle();
    return;
  }
  player.load(book, stateOf(book.id));
  void updateSettings({ lastBookId: book.id });
  void player.play();
}

function showPlayer() {
  if (!player.book) return;
  view = 'player';
  closePopover();
  $('#library-view').hidden = true;
  topbar.hidden = true;
  $('#player-view').hidden = false;
  renderSidebar();
  renderMini();
  renderPlayer();
}

function showLibrary() {
  view = 'library';
  panel = null;
  closePopover();
  $('#player-view').hidden = true;
  topbar.hidden = false;
  $('#library-view').hidden = false;
  renderSidebar();
  renderLibrary();
  renderMini();
}

// ==================================================================== player view

const playerView = $('#player-view');
const ui = {
  headTitle: h('div', { class: 'head-title' }),
  backdrop: h('div', { class: 'player-backdrop', 'aria-hidden': 'true' }),
  cover: h('div') as HTMLElement,
  author: h('div', { class: 'player-author' }),
  title: h('h1', { class: 'player-title' }),
  chapterName: h('div', { class: 'chapter-name' }),
  chapterMeta: h('div', { class: 'chapter-meta' }),
  slider: h('input', { type: 'range', class: 'slider', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Position in chapter' }),
  elapsed: h('span'),
  remaining: h('span'),
  play: h('button', { class: 'icon-btn play-btn', title: 'Play (Space)' }),
  bookProgress: h('div', { class: 'book-progress' }),
  speed: h('button', { class: 'tool', title: 'Playback speed' }),
  sleep: h('button', { class: 'tool', title: 'Sleep timer (T)' }),
  silence: h('button', { class: 'tool', title: 'Skip silence' }),
  boost: h('button', { class: 'tool', title: 'Volume boost' }),
  bookmark: h('button', { class: 'tool', title: 'Add bookmark (B)' }),
  error: h('div', { class: 'player-error', hidden: true }),
  panelHost: h('div'),
  rewindLabel: h('span', { class: 'skip-label' }),
  forwardLabel: h('span', { class: 'skip-label' }),
};
let seeking = false;

function buildPlayerView() {
  const rewind = h(
    'button',
    { class: 'icon-btn skip-btn', onclick: () => player.skip(-snap.settings.skipBackSeconds * 1000) },
    icon('rewind'),
    ui.rewindLabel,
  );
  const forward = h(
    'button',
    { class: 'icon-btn skip-btn', onclick: () => player.skip(snap.settings.skipForwardSeconds * 1000) },
    icon('forward'),
    ui.forwardLabel,
  );
  const chapterButton = h(
    'button',
    { class: 'chapter-button', title: 'Chapters (C)', onclick: () => togglePanel('chapters') },
    icon('chapters'),
    h('div', { class: 'chapter-texts' }, ui.chapterName, ui.chapterMeta),
  );
  ui.play.addEventListener('click', () => player.toggle());
  ui.slider.addEventListener('input', () => {
    seeking = true;
    const chapter = player.chapter;
    if (!chapter) return;
    const ms = chapter.startMs + (Number(ui.slider.value) / 1000) * (chapter.endMs - chapter.startMs);
    ui.elapsed.textContent = formatTime(ms - chapter.startMs);
    ui.remaining.textContent = `-${formatTime(chapter.endMs - ms)}`;
    ui.slider.style.setProperty('--pct', `${Number(ui.slider.value) / 10}%`);
  });
  ui.slider.addEventListener('change', () => {
    const chapter = player.chapter;
    seeking = false;
    if (!chapter) return;
    const ms = chapter.startMs + (Number(ui.slider.value) / 1000) * (chapter.endMs - chapter.startMs);
    player.seekTrack(chapter.trackIndex, Math.min(ms, chapter.endMs - 250));
  });
  ui.speed.addEventListener('click', () => speedPopover(ui.speed));
  ui.sleep.addEventListener('click', () => sleepPopover(ui.sleep));
  ui.silence.addEventListener('click', () => {
    player.setSkipSilence(!player.skipSilence);
    toast(player.skipSilence ? 'Skip silence on' : 'Skip silence off');
  });
  ui.boost.addEventListener('click', () => boostPopover(ui.boost));
  ui.bookmark.addEventListener('click', () => void addBookmark());

  replaceChildren(
    playerView,
    ui.backdrop,
    h(
      'div',
      { class: 'player-head' },
      h('button', { class: 'icon-btn', title: 'Back to library (Esc)', onclick: showLibrary }, icon('back')),
      ui.headTitle,
      h('div', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Bookmarks', onclick: () => togglePanel('bookmarks') }, icon('bookmark')),
      h('button', { class: 'icon-btn', title: 'Chapters', onclick: () => togglePanel('chapters') }, icon('chapters')),
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'More',
          onclick: (e: MouseEvent) => player.book && bookMenu(e, player.book),
        },
        icon('more'),
      ),
    ),
    h(
      'div',
      { class: 'player-body' },
      ui.cover,
      h(
        'div',
        { class: 'player-info' },
        ui.author,
        ui.title,
        chapterButton,
        h('div', { class: 'seek' }, ui.slider, h('div', { class: 'times' }, ui.elapsed, ui.remaining)),
        h(
          'div',
          { class: 'controls' },
          h('button', { class: 'icon-btn', title: 'Previous chapter (Shift+←)', onclick: () => player.previousChapter() }, icon('previous')),
          rewind,
          ui.play,
          forward,
          h('button', { class: 'icon-btn', title: 'Next chapter (Shift+→)', onclick: () => player.nextChapter() }, icon('next')),
        ),
        ui.bookProgress,
        h('div', { class: 'tools' }, ui.speed, ui.sleep, ui.silence, ui.boost, ui.bookmark),
        ui.error,
      ),
    ),
    ui.panelHost,
  );
}

let renderedCoverFor: string | null = null;
function renderPlayer() {
  const book = player.book;
  if (!book || view !== 'player') return;
  ui.headTitle.textContent = 'Now playing';
  const coverKey = `${book.id}|${book.coverUrl}`;
  if (renderedCoverFor !== coverKey) {
    renderedCoverFor = coverKey;
    const cover = coverEl(book, 'player-cover');
    ui.cover.replaceWith(cover);
    ui.cover = cover;
    ui.backdrop.style.backgroundImage = book.coverUrl ? `url("${book.coverUrl}")` : '';
    ui.backdrop.style.setProperty('--hue', String(hashHue(book.name)));
    ui.backdrop.classList.toggle('no-cover', !book.coverUrl);
  }
  ui.author.textContent = book.author ?? '';
  ui.author.hidden = !book.author;
  ui.title.textContent = book.name;
  ui.title.title = book.name;
  replaceChildren(ui.play, icon(player.playing ? 'pause' : 'play'));
  ui.play.title = player.playing ? 'Pause (Space)' : 'Play (Space)';
  ui.rewindLabel.textContent = String(snap.settings.skipBackSeconds);
  ui.forwardLabel.textContent = String(snap.settings.skipForwardSeconds);
  (ui.rewindLabel.parentElement as HTMLElement).title = `Rewind ${snap.settings.skipBackSeconds} s (←)`;
  (ui.forwardLabel.parentElement as HTMLElement).title = `Forward ${snap.settings.skipForwardSeconds} s (→)`;

  replaceChildren(ui.speed, icon('speed'), `${player.speed.toFixed(2).replace(/0$/, '')}×`);
  ui.speed.classList.toggle('active', player.speed !== 1);
  ui.silence.classList.toggle('active', player.skipSilence);
  replaceChildren(ui.silence, icon('silence'), 'Skip silence');
  ui.boost.classList.toggle('active', player.gainDb > 0);
  replaceChildren(ui.boost, icon('volume'), player.gainDb > 0 ? `+${player.gainDb} dB` : 'Boost');
  replaceChildren(ui.bookmark, icon('bookmarkAdd'));
  ui.bookmark.classList.add('icon-only');
  ui.error.hidden = !player.error;
  ui.error.textContent = player.error ?? '';
  renderSleepTool();
  renderPlayerTime();
  renderPanel();
}

function renderSleepTool() {
  const sleep = player.sleep;
  ui.sleep.classList.toggle('active', sleep.kind !== 'off');
  const label =
    sleep.kind === 'time'
      ? formatTime(player.sleepRemainingMs ?? 0)
      : sleep.kind === 'chapter'
        ? 'End of chapter'
        : 'Sleep';
  replaceChildren(ui.sleep, icon('sleep'), label);
}

function renderPlayerTime() {
  const book = player.book;
  if (!book) return;
  const chapter = player.chapter;
  const pos = player.positionMs;
  if (chapter) {
    const len = chapter.endMs - chapter.startMs;
    const into = Math.min(Math.max(0, pos - chapter.startMs), len);
    ui.chapterName.textContent = chapter.title;
    ui.chapterMeta.textContent =
      player.chapters.length > 1 ? `Chapter ${chapter.index + 1} of ${player.chapters.length}` : formatTime(len);
    if (!seeking) {
      const value = len > 0 ? Math.round((into / len) * 1000) : 0;
      ui.slider.value = String(value);
      ui.slider.style.setProperty('--pct', `${value / 10}%`);
      ui.elapsed.textContent = formatTime(into);
      ui.remaining.textContent = `-${formatTime(len - into)}`;
    }
  }
  const bookPos = player.bookPositionMs;
  const left = (book.durationMs - bookPos) / (player.speed || 1);
  ui.bookProgress.textContent = `${formatTime(bookPos)} of ${formatTime(book.durationMs)} · ${formatDuration(Math.max(0, left))} left${
    player.speed !== 1 ? ` at ${player.speed}×` : ''
  }`;
  if (player.sleep.kind === 'time') renderSleepTool();
}

// ---------------------------------------------------------------- side panel

function togglePanel(which: 'chapters' | 'bookmarks') {
  if (view !== 'player') showPlayer();
  panel = panel === which ? null : which;
  renderPanel();
}

let renderedPanelKey = '';
function renderPanel(force = false) {
  const book = player.book;
  if (!panel || !book) {
    clear(ui.panelHost);
    renderedPanelKey = '';
    return;
  }
  const state = stateOf(book.id);
  const current = player.chapter;
  const key = `${panel}|${book.id}|${current?.index}|${state.bookmarks.length}|${state.bookmarks.map((b) => b.title).join()}`;
  if (!force && key === renderedPanelKey) return;
  renderedPanelKey = key;

  const tab = (id: 'chapters' | 'bookmarks', label: string) =>
    h('button', { class: `tab${panel === id ? ' active' : ''}`, onclick: () => ((panel = id), renderPanel()) }, label);

  let body: HTMLElement;
  if (panel === 'chapters') {
    body = h(
      'div',
      null,
      player.chapters.map((chapter) =>
        h(
          'button',
          {
            class: `item${current?.index === chapter.index ? ' current' : ''}`,
            onclick: () => {
              player.seekTrack(chapter.trackIndex, chapter.startMs);
              if (!player.playing) void player.play();
            },
          },
          h('span', { class: 'item-index' }, String(chapter.index + 1)),
          h(
            'div',
            { class: 'item-main' },
            h('div', { class: 'item-title', title: chapter.title }, chapter.title),
            h('div', { class: 'item-sub' }, `${formatTime(chapter.bookStartMs)} · ${formatTime(chapter.endMs - chapter.startMs)}`),
          ),
        ),
      ),
    );
  } else {
    const bookmarks = [...state.bookmarks].sort(
      (a, b) => bookPositionMs(book, a.trackIndex, a.positionMs) - bookPositionMs(book, b.trackIndex, b.positionMs),
    );
    body = bookmarks.length
      ? h('div', null, bookmarks.map((bm) => bookmarkItem(book, bm)))
      : h(
          'div',
          { class: 'panel-empty' },
          'No bookmarks yet.',
          h('br'),
          'Press ',
          h('kbd', null, 'B'),
          ' or the Bookmark button to remember a spot.',
        );
  }
  replaceChildren(
    ui.panelHost,
    h(
      'aside',
      { class: 'panel' },
      h(
        'div',
        { class: 'panel-head' },
        h('div', { class: 'tabs' }, tab('chapters', `Chapters · ${player.chapters.length}`), tab('bookmarks', `Bookmarks · ${state.bookmarks.length}`)),
        h('button', { class: 'icon-btn', title: 'Close', onclick: () => ((panel = null), renderPanel()) }, icon('close')),
      ),
      h('div', { class: 'panel-body' }, body),
    ),
  );
  if (panel === 'chapters') {
    ui.panelHost.querySelector('.item.current')?.scrollIntoView({ block: 'center' });
  }
}

function bookmarkItem(book: Book, bm: Bookmark): HTMLElement {
  const pos = bookPositionMs(book, bm.trackIndex, bm.positionMs);
  const chapter = player.chapters.length ? player.chapters.find((c) => c.trackIndex === bm.trackIndex && c.startMs <= bm.positionMs && bm.positionMs < c.endMs) : null;
  return h(
    'div',
    { class: 'item', role: 'button', tabindex: '0', onclick: () => player.seekTrack(bm.trackIndex, bm.positionMs) },
    icon('bookmark'),
    h(
      'div',
      { class: 'item-main' },
      h('div', { class: 'item-title', title: bm.title }, bm.title),
      h('div', { class: 'item-sub' }, `${formatTime(pos)}${chapter ? ` · ${chapter.title}` : ''}`),
    ),
    h(
      'div',
      { class: 'item-actions' },
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'Rename',
          onclick: async (e: MouseEvent) => {
            e.stopPropagation();
            const title = await prompt('Rename bookmark', bm.title);
            if (title === null) return;
            const bookmarks = stateOf(book.id).bookmarks.map((b) => (b.id === bm.id ? { ...b, title } : b));
            saveState(book.id, { bookmarks });
            renderPanel(true);
          },
        },
        icon('edit'),
      ),
      h(
        'button',
        {
          class: 'icon-btn',
          title: 'Delete',
          onclick: (e: MouseEvent) => {
            e.stopPropagation();
            saveState(book.id, { bookmarks: stateOf(book.id).bookmarks.filter((b) => b.id !== bm.id) });
            renderPanel(true);
            toast('Bookmark deleted');
          },
        },
        icon('trash'),
      ),
    ),
  );
}

async function addBookmark() {
  const book = player.book;
  if (!book) return;
  const trackIndex = player.trackIndex;
  const positionMs = player.positionMs;
  const chapter = player.chapter;
  const suggested = chapter ? `${chapter.title} – ${formatTime(positionMs - chapter.startMs)}` : formatTime(positionMs);
  const title = await prompt('Add bookmark', suggested, 'Add');
  if (title === null) return;
  const bookmark: Bookmark = { id: crypto.randomUUID(), title, trackIndex, positionMs, createdAt: Date.now() };
  saveState(book.id, { bookmarks: [...stateOf(book.id).bookmarks, bookmark] });
  toast('Bookmark added');
  renderPanel(true);
}

// ---------------------------------------------------------------- popovers

function chips<T>(values: T[], label: (v: T) => string, selected: (v: T) => boolean, pick: (v: T) => void) {
  return h(
    'div',
    { class: 'chips' },
    values.map((v) => h('button', { class: `chip${selected(v) ? ' selected' : ''}`, onclick: () => pick(v) }, label(v))),
  );
}

function speedPopover(anchor: HTMLElement) {
  const value = h('div', { class: 'pop-value' });
  const slider = h('input', { type: 'range', class: 'slider', min: '0.5', max: '3.5', step: '0.05', 'aria-label': 'Playback speed' });
  const sync = () => {
    value.textContent = `${player.speed.toFixed(2)}×`;
    slider.value = String(player.speed);
    slider.style.setProperty('--pct', `${((player.speed - 0.5) / 3) * 100}%`);
    content.querySelectorAll<HTMLButtonElement>('.chip').forEach((c) => c.classList.toggle('selected', Number(c.dataset.v) === player.speed));
  };
  slider.addEventListener('input', () => {
    player.setSpeed(Number(slider.value));
    sync();
  });
  const preset = chips(
    [0.8, 1, 1.2, 1.5, 1.75, 2, 2.5, 3],
    (v) => `${v}×`,
    (v) => v === player.speed,
    (v) => {
      player.setSpeed(v);
      sync();
    },
  );
  preset.querySelectorAll<HTMLButtonElement>('.chip').forEach((c, i) => (c.dataset.v = String([0.8, 1, 1.2, 1.5, 1.75, 2, 2.5, 3][i])));
  const content = h(
    'div',
    { class: 'pop-section', style: 'width:300px' },
    h('div', { class: 'menu-label', style: 'padding-left:0' }, 'Playback speed'),
    value,
    h(
      'div',
      { style: 'display:flex;align-items:center;gap:8px' },
      h('button', { class: 'icon-btn', title: 'Slower ([)', onclick: () => (player.setSpeed(player.speed - 0.05), sync()) }, '−'),
      slider,
      h('button', { class: 'icon-btn', title: 'Faster (])', onclick: () => (player.setSpeed(player.speed + 0.05), sync()) }, '+'),
    ),
    preset,
  );
  sync();
  openPopover(content, anchor, 'above');
}

function sleepPopover(anchor: HTMLElement) {
  const sleep = player.sleep;
  const entries: MenuEntry[] = [{ heading: 'Sleep timer' }];
  if (sleep.kind !== 'off') {
    if (sleep.kind === 'time') {
      entries.push({ label: 'Add 5 minutes', icon: 'add', action: () => player.extendSleep(5) });
      entries.push({ label: 'Add 15 minutes', icon: 'add', action: () => player.extendSleep(15) });
    }
    entries.push({ label: 'Turn off', icon: 'close', danger: true, action: () => (player.sleepOff(), toast('Sleep timer off')) });
    entries.push('separator');
  }
  for (const minutes of [5, 10, 15, 20, 30, 45, 60, 90]) {
    entries.push({
      label: `${minutes} minutes`,
      icon: 'sleep',
      selected: sleep.kind === 'time' && sleep.minutes === minutes,
      hint: minutes === snap.settings.sleepTimerMinutes ? 'Default (T)' : undefined,
      action: () => {
        player.setSleepMinutes(minutes);
        void updateSettings({ sleepTimerMinutes: minutes });
        toast(`Sleeping in ${minutes} minutes`);
      },
    });
  }
  entries.push({
    label: 'End of chapter',
    icon: 'chapters',
    selected: sleep.kind === 'chapter',
    action: () => {
      player.setSleepEndOfChapter();
      toast('Stopping at the end of this chapter');
    },
  });
  openPopover(menu(entries), anchor, 'above');
}

function boostPopover(anchor: HTMLElement) {
  const value = h('div', { class: 'pop-value' });
  const slider = h('input', { type: 'range', class: 'slider', min: '0', max: '12', step: '1', 'aria-label': 'Volume boost' });
  const sync = () => {
    value.textContent = player.gainDb > 0 ? `+${player.gainDb} dB` : 'Off';
    slider.value = String(player.gainDb);
    slider.style.setProperty('--pct', `${(player.gainDb / 12) * 100}%`);
  };
  slider.addEventListener('input', () => {
    player.setGainDb(Number(slider.value));
    sync();
  });
  const content = h(
    'div',
    { class: 'pop-section', style: 'width:280px' },
    h('div', { class: 'menu-label', style: 'padding-left:0' }, 'Volume boost'),
    value,
    slider,
    h('div', { class: 'field-desc' }, 'Makes quiet recordings louder. High values may distort.'),
  );
  sync();
  openPopover(content, anchor, 'above');
}

// ==================================================================== mini player

const mini = $('#mini-player');
const miniUi = {
  progress: h('div'),
  book: h('button', { class: 'mini-book', title: 'Open player' }),
  play: h('button', { class: 'icon-btn play-btn' }),
  right: h('div', { class: 'mini-right' }),
  title: h('div', { class: 'mini-title' }),
  sub: h('div', { class: 'mini-sub' }),
  time: h('span'),
  coverKey: '',
};

function buildMini() {
  miniUi.book.addEventListener('click', showPlayer);
  miniUi.play.addEventListener('click', () => player.toggle());
  replaceChildren(
    mini,
    h('div', { class: 'mini-progress' }, miniUi.progress),
    miniUi.book,
    h(
      'div',
      { class: 'mini-controls' },
      h('button', { class: 'icon-btn', title: 'Rewind', onclick: () => player.skip(-snap.settings.skipBackSeconds * 1000) }, icon('rewind')),
      miniUi.play,
      h('button', { class: 'icon-btn', title: 'Forward', onclick: () => player.skip(snap.settings.skipForwardSeconds * 1000) }, icon('forward')),
    ),
    miniUi.right,
  );
}

function renderMini() {
  const book = player.book;
  mini.hidden = !book || view === 'player';
  if (!book || view === 'player') return;
  const key = `${book.id}|${book.coverUrl}`;
  if (miniUi.coverKey !== key) {
    miniUi.coverKey = key;
    replaceChildren(miniUi.book, coverEl(book), h('div', { class: 'mini-texts' }, miniUi.title, miniUi.sub));
  }
  miniUi.title.textContent = book.name;
  replaceChildren(miniUi.play, icon(player.playing ? 'pause' : 'play'));
  miniUi.play.title = player.playing ? 'Pause' : 'Play';
  replaceChildren(
    miniUi.right,
    player.sleep.kind !== 'off' ? h('span', { title: 'Sleep timer active' }, icon('sleep')) : null,
    player.speed !== 1 ? h('span', null, `${player.speed}× · `) : null,
    miniUi.time,
    h('button', { class: 'icon-btn', title: 'Chapters', onclick: () => togglePanel('chapters') }, icon('chapters')),
    h('button', { class: 'icon-btn', title: 'Open player', onclick: showPlayer }, icon('expand')),
  );
  renderMiniTime();
}

function renderMiniTime() {
  const book = player.book;
  if (!book || mini.hidden) return;
  const chapter = player.chapter;
  miniUi.sub.textContent = chapter && player.chapters.length > 1 ? chapter.title : (book.author ?? '');
  const pos = player.bookPositionMs;
  miniUi.progress.style.width = `${book.durationMs ? (pos / book.durationMs) * 100 : 0}%`;
  miniUi.time.textContent = `${formatTime(pos)} / ${formatTime(book.durationMs)}`;
}

// ==================================================================== settings dialog

function openSettings() {
  const s = snap.settings;
  const body = h('div');
  const render = () => {
    replaceChildren(
      body,
      h('div', { class: 'field-group' }, 'Library folders'),
      snap.folders.length === 0 ? h('div', { class: 'field-desc', style: 'padding:8px 0' }, 'No folders yet.') : null,
      snap.folders.map((folder) => {
        const kind = h(
          'select',
          {
            class: 'select',
            onchange: () => void api.setFolderKind(folder.id, kind.value as LibraryFolderKind),
          },
          FOLDER_KINDS.filter((k) => (folder.kind === 'file' ? k.kind === 'file' : k.kind !== 'file')).map((k) =>
            h('option', { value: k.kind, selected: k.kind === folder.kind }, k.label),
          ),
        );
        const count = snap.books.filter((b) => b.folderId === folder.id).length;
        return h(
          'div',
          { class: 'field' },
          icon(folder.kind === 'file' ? 'headphones' : 'folder'),
          h(
            'div',
            { class: 'field-text' },
            h('div', { class: 'folder-path', title: folder.path }, `\u200e${folder.path}\u200e`),
            h('div', { class: 'field-desc' }, `${kindLabel(folder.kind)} · ${count} book${count === 1 ? '' : 's'}`),
          ),
          kind,
          h(
            'button',
            {
              class: 'icon-btn',
              title: 'Remove from library (files are not deleted)',
              onclick: async () => {
                await api.removeFolder(folder.id);
                toast('Folder removed from library');
              },
            },
            icon('trash'),
          ),
        );
      }),
      h(
        'div',
        { style: 'display:flex;gap:8px;margin-top:12px' },
        (() => {
          const btn: HTMLButtonElement = h('button', { class: 'btn', onclick: () => addMenu(btn) }, icon('add'), 'Add');
          return btn;
        })(),
        h('button', { class: 'btn ghost', onclick: () => void api.rescan() }, icon('refresh'), 'Rescan'),
      ),

      h('div', { class: 'field-group' }, 'Playback'),
      selectField('Rewind', 'How far the rewind button jumps back.', [5, 10, 15, 20, 30, 45, 60, 90], s.skipBackSeconds, (v) => `${v} seconds`, (v) =>
        updateSettings({ skipBackSeconds: v }).then(renderAll),
      ),
      selectField('Fast forward', 'How far the forward button jumps ahead.', [5, 10, 15, 20, 30, 45, 60, 90], s.skipForwardSeconds, (v) => `${v} seconds`, (v) =>
        updateSettings({ skipForwardSeconds: v }).then(renderAll),
      ),
      selectField('Auto rewind', 'Jump back a little when resuming after a pause, so you don’t lose context.', [0, 1, 2, 3, 5, 10], s.autoRewindSeconds, (v) => (v ? `${v} seconds` : 'Off'), (v) =>
        updateSettings({ autoRewindSeconds: v }),
      ),
      selectField('Default speed', 'Speed for books you have not played yet. Each book remembers its own speed.', [0.8, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2], s.defaultSpeed, (v) => `${v}×`, (v) =>
        updateSettings({ defaultSpeed: v }),
      ),
      switchField('Fade out sleep timer', 'Lower the volume during the last 10 seconds before stopping.', s.sleepFadeOut, (v) => updateSettings({ sleepFadeOut: v })),

      h('div', { class: 'field-group' }, 'App'),
      selectField('Theme', 'Choose light, dark, or follow Windows.', ['system', 'dark', 'light'] as const, s.theme, (v) => ({ system: 'Use Windows setting', dark: 'Dark', light: 'Light' })[v], (v) =>
        updateSettings({ theme: v }),
      ),
      switchField('Keep running in the tray', 'Closing the window keeps playing in the background. Quit from the tray icon.', s.minimizeToTray, (v) =>
        updateSettings({ minimizeToTray: v }),
      ),

      h('div', { class: 'field-group' }, 'Keyboard shortcuts'),
      h(
        'div',
        { class: 'shortcuts' },
        shortcut('Space', 'Play / pause'),
        shortcut('← / →', 'Rewind / fast forward'),
        shortcut('Shift + ← / →', 'Previous / next chapter'),
        shortcut('[ / ]', 'Slower / faster'),
        shortcut('B', 'Add bookmark'),
        shortcut('C', 'Show chapters'),
        shortcut('T', 'Toggle sleep timer'),
        shortcut('Ctrl + F', 'Search library'),
        shortcut('Esc', 'Back to library'),
        shortcut('Media keys', 'Play / pause, previous / next chapter'),
      ),

      h('div', { class: 'field-group' }, 'About'),
      h(
        'div',
        { class: 'field-desc', style: 'line-height:1.6' },
        'Voice Desktop — a minimal audiobook player for Windows, inspired by ',
        h('a', { href: 'https://github.com/PaulWoitaschek/Voice', target: '_blank', style: 'color:var(--accent)' }, 'Voice for Android'),
        '. Licensed under the GPL-3.0.',
      ),
    );
  };
  const off = api.onLibraryChanged(() => setTimeout(render, 0));
  render();
  openDialog({ title: 'Settings', body, onClose: off });
}

function shortcut(keys: string, what: string) {
  return [h('div', null, keys.split(' / ').map((k, i) => [i ? ' / ' : '', h('kbd', null, k)])), h('div', null, what)];
}

function selectField<T extends string | number>(
  label: string,
  desc: string,
  values: readonly T[],
  current: T,
  text: (v: T) => string,
  onChange: (v: T) => unknown,
) {
  const select = h(
    'select',
    {
      class: 'select',
      onchange: () => {
        const v = values[Number(select.value)];
        void onChange(v);
      },
    },
    values.map((v, i) => h('option', { value: String(i), selected: v === current }, text(v))),
  );
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-text' }, h('div', { class: 'field-label' }, label), h('div', { class: 'field-desc' }, desc)),
    select,
  );
}

function switchField(label: string, desc: string, current: boolean, onChange: (v: boolean) => unknown) {
  const input = h('input', { type: 'checkbox', class: 'switch', checked: current, onchange: () => void onChange(input.checked) });
  return h(
    'label',
    { class: 'field' },
    h('div', { class: 'field-text' }, h('div', { class: 'field-label' }, label), h('div', { class: 'field-desc' }, desc)),
    input,
  );
}

// ==================================================================== input: keyboard, media keys, drag & drop

function command(cmd: PlayerCommand) {
  if (!player.book) {
    const last = snap.books.find((b) => b.id === snap.settings.lastBookId) ?? snap.books[0];
    if (!last || (cmd !== 'play' && cmd !== 'toggle')) return;
    player.load(last, stateOf(last.id));
  }
  switch (cmd) {
    case 'toggle':
      return player.toggle();
    case 'play':
      return void player.play();
    case 'pause':
      return player.pause();
    case 'next':
      return player.nextChapter();
    case 'previous':
      return player.previousChapter();
    case 'rewind':
      return player.skip(-snap.settings.skipBackSeconds * 1000);
    case 'forward':
      return player.skip(snap.settings.skipForwardSeconds * 1000);
  }
}

document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  const typing = target.tagName === 'INPUT' && !['range', 'checkbox'].includes((target as HTMLInputElement).type);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  if (typing || target.tagName === 'SELECT' || dialogOpen > 0 || e.ctrlKey || e.altKey || e.metaKey) return;
  switch (e.key) {
    case ' ':
      if (target.tagName === 'BUTTON' && !player.book) return;
      e.preventDefault();
      command('toggle');
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) player.previousChapter();
      else command('rewind');
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) player.nextChapter();
      else command('forward');
      break;
    case '[':
      player.setSpeed(player.speed - 0.1);
      toast(`Speed ${player.speed}×`);
      break;
    case ']':
      player.setSpeed(player.speed + 0.1);
      toast(`Speed ${player.speed}×`);
      break;
    case 'b':
    case 'B':
      if (player.book) void addBookmark();
      break;
    case 'c':
    case 'C':
      if (player.book) togglePanel('chapters');
      break;
    case 't':
    case 'T':
      if (!player.book) break;
      if (player.sleep.kind === 'off') {
        player.setSleepMinutes(snap.settings.sleepTimerMinutes);
        toast(`Sleeping in ${snap.settings.sleepTimerMinutes} minutes`);
      } else {
        player.sleepOff();
        toast('Sleep timer off');
      }
      break;
    case 'Escape':
      if (panel) {
        panel = null;
        renderPanel();
      } else if (view === 'player') showLibrary();
      else if (search) {
        searchInput.value = '';
        search = '';
        renderLibrary();
      }
      break;
  }
});

if ('mediaSession' in navigator) {
  const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
    ['play', () => command('play')],
    ['pause', () => command('pause')],
    ['stop', () => command('pause')],
    ['previoustrack', () => command('previous')],
    ['nexttrack', () => command('next')],
    ['seekbackward', (d) => player.skip(-(d.seekOffset ?? snap.settings.skipBackSeconds) * 1000)],
    ['seekforward', (d) => player.skip((d.seekOffset ?? snap.settings.skipForwardSeconds) * 1000)],
    [
      'seekto',
      (d) => {
        const chapter = player.chapter;
        if (chapter && d.seekTime !== undefined) player.seekTrack(chapter.trackIndex, chapter.startMs + d.seekTime * 1000);
      },
    ],
  ];
  for (const [action, handler] of handlers) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch {
      /* unsupported action */
    }
  }
}

const dropOverlay = $('#drop-overlay');
replaceChildren($('.drop-icon', dropOverlay), icon('folder'));
let dragDepth = 0;
const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.hidden = true;
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  const paths = Array.from(e.dataTransfer?.files ?? [])
    .map((f) => api.pathForFile(f))
    .filter(Boolean);
  if (paths.length === 0) return;
  await api.addPaths(paths);
  toast(`Added ${paths.length === 1 ? 'it' : `${paths.length} items`} — scanning…`);
});

// ==================================================================== wiring

function renderAll() {
  renderTopbar();
  if (view === 'library') renderLibrary();
  renderPlayer();
  renderMini();
}

let lastReported = '';
player.subscribe(() => {
  renderPlayer();
  renderMini();
  scheduleLibraryRender();
  const book = player.book;
  const report = { bookId: book?.id ?? null, title: book?.name ?? null, playing: player.playing };
  const key = JSON.stringify(report);
  if (key !== lastReported) {
    lastReported = key;
    api.reportNowPlaying(report);
  }
});

let lastTimeRender = 0;
player.subscribeTime(() => {
  const now = performance.now();
  if (now - lastTimeRender < 200) return;
  lastTimeRender = now;
  if (view === 'player') {
    renderPlayerTime();
    renderPanel();
  } else {
    renderMiniTime();
  }
});

function applySnapshot(next: LibrarySnapshot) {
  // Keep local state for the book that is playing: it is newer than what main has.
  const local = player.book ? snap.states[player.book.id] : undefined;
  snap = next;
  if (local && player.book) snap.states[player.book.id] = { ...next.states[player.book.id], ...local };
  if (player.book) {
    const updated = snap.books.find((b) => b.id === player.book!.id);
    if (!updated) {
      player.unload();
      if (view === 'player') showLibrary();
    } else if (updated !== player.book) {
      player.load(updated, stateOf(updated.id));
    }
  }
  applyTheme();
  renderAll();
}

async function init() {
  snap = await api.getSnapshot();
  applyTheme();
  buildSidebar();
  buildTopbar();
  buildPlayerView();
  buildMini();
  const last = snap.books.find((b) => b.id === snap.settings.lastBookId);
  if (last) player.load(last, stateOf(last.id));
  renderAll();

  api.onLibraryChanged(applySnapshot);
  api.onScanProgress((p) => {
    scanText = p.total ? `Scanning ${p.done}/${p.total}${p.current ? ` · ${p.current}` : ''}` : '';
    renderTopbar();
    if (snap.books.length === 0 && view === 'library') renderLibrary();
  });
  api.onCommand(command);
  api.onOpenBook((id) => {
    snap.books.length && openBook(id, true);
  });
  api.onFlush(() => player.persistNow());
  window.addEventListener('beforeunload', () => player.persistNow());
}

void init();
