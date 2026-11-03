# Voice Desktop

A minimal, distraction-free **audiobook player for Windows**, inspired by
[Voice](https://github.com/PaulWoitaschek/Voice), the open-source Android
audiobook player by Paul Woitaschek.

Point it at the folder where your audiobooks live. It finds your books, reads
their chapters and covers, and remembers exactly where you stopped in each one.

## Features

- **Library from folders.** Add a folder and every subfolder or audio file in it
  becomes a book. There are also *authors* folders (`Author\Book\files`),
  *single book* folders (`Book\01.mp3, 02.mp3…` or `Book\CD1, CD2…`) and single
  files. You can drag and drop folders or files onto the window. New books are
  picked up automatically when files change.
- **Resumes where you left off.** Each book saves its own position, playback
  speed, skip-silence and volume-boost settings.
- **Chapters.** Multi-file books get one chapter per file. Embedded chapters in
  `.m4b` / `.m4a` / `.mp3` files are read and listed. You can jump between
  chapters with the buttons, the chapter list or the keyboard.
- **Playback speed** from 0.5× to 3.5×, with pitch preserved.
- **Skip silence.** Silent passages are played at high speed.
- **Volume boost** of up to +12 dB for quiet recordings.
- **Sleep timer**: set minutes or *end of chapter*, extend it while it runs,
  and optionally fade out.
- **Bookmarks** that you can name, rename and delete.
- **Auto rewind** of a few seconds when you resume after a pause.
- **Covers.** It uses `cover.jpg` / `folder.jpg` and similar files next to the
  audio, or art embedded in the files. You can also set your own cover.
- **Windows integration**:
  - media keys, plus the Windows media overlay with cover and chapter title
  - taskbar thumbnail buttons (previous, rewind, play/pause, forward, next)
  - an optional tray icon so playback keeps going after you close the window
  - `.m4b` file association
  - the system stays awake while a book is playing
- **Light and dark theme**, or follow the Windows setting.
- Supported formats: MP3, M4B, M4A, MP4, AAC, OGG, Opus, FLAC, WAV, WebM and MKA.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> / <kbd>→</kbd> | Rewind / fast forward (amounts configurable) |
| <kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd> | Previous / next chapter |
| <kbd>[</kbd> / <kbd>]</kbd> | Slower / faster |
| <kbd>B</kbd> | Add bookmark |
| <kbd>C</kbd> | Show chapters |
| <kbd>T</kbd> | Toggle sleep timer |
| <kbd>Ctrl</kbd>+<kbd>F</kbd> | Search the library |
| <kbd>Esc</kbd> | Back to the library |

## Install (Windows)

Download the latest build from the
[**Releases** page](https://github.com/mohamedimoo/voice-audiobook-reader-/releases/latest):

- `Voice Desktop-<version>-portable.exe`: double-click to run. Nothing to
  install, so you can keep it anywhere, even on a USB stick.
- `Voice Desktop-Setup-<version>.exe`: installer with Start Menu and desktop
  shortcuts.

Every push to the default branch rebuilds both files on a Windows machine
(GitHub Actions) and updates that release. The files are also kept as the
`voice-desktop-windows` artifact of each workflow run.

The builds are not code-signed, so Windows SmartScreen may warn the first time
you run them. Choose *More info → Run anyway*.

## Build from source

Requirements: [Node.js](https://nodejs.org/) 22+ and Git.

```bash
git clone https://github.com/mohamedimoo/voice-audiobook-reader-.git
```

```bash
cd voice-audiobook-reader-
```

```bash
npm install
```

Run the app in development mode:

```bash
npm start
```

Build the Windows installer and portable `.exe` into `release/` (run this on
Windows):

```bash
npm run dist:win
```

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks the whole project |
| `npm test` | Unit and integration tests (scanner tests need `ffmpeg` on the `PATH` and are skipped without it) |
| `npm run icons` | Regenerates the app, tray and taskbar PNG icons from `build/logo.svg` (needs the `playwright` package) |

To publish a new version, bump `version` in `package.json` and push. The
workflow creates the matching `v<version>` release.

## How it works

The app is built with [Electron](https://www.electronjs.org/) and TypeScript.

```
src/
  main/        Electron main process
    main.ts      window, IPC, voice:// protocol, tray, taskbar buttons
    library.ts   library folders, scanning, cached metadata, saved positions
    scanner.ts   finds books on disk, reads tags/chapters/covers (music-metadata)
    store.ts     atomic, debounced JSON persistence
  preload/     the small, typed API exposed to the UI (window.voice)
  renderer/    the UI: library, player, popovers, settings (plain DOM, no framework)
    player.ts    audio engine: tracks, chapters, speed, skip silence, boost, sleep timer
  shared/      types and chapter/position maths shared by both sides
test/          node:test tests
```

- Audio and covers are served to the UI through a custom `voice://` protocol
  with HTTP range support, so seeking is instant. The protocol only serves
  files that belong to the library.
- The UI runs sandboxed with context isolation and a strict Content Security
  Policy. It has no Node.js access.
- Your data is stored as JSON in `%APPDATA%\Voice Desktop`: `library.json`
  holds folders, positions and bookmarks, `settings.json` holds settings, and
  `cache.json` holds scanned metadata. Set the `VOICE_USER_DATA` environment
  variable to use a different folder.

## License

GPL-3.0-or-later, the same license as the original Voice app. See
[LICENSE](LICENSE). This is an independent project and is not affiliated with
the Voice app or its author.
