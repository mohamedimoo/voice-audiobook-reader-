import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { findCandidates, readFileMeta, trackTitles, bookName, type FileMeta } from '../src/main/scanner';
import { guessKind, Library } from '../src/main/library';
import { chaptersOf } from '../src/shared/chapters';

let hasFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
} catch {
  hasFfmpeg = false;
}

let root = '';

function tone(file: string, seconds: number, extra: string[] = []) {
  mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...extra, file]);
}

before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'voice-test-'));
  if (!hasFfmpeg) return;
  // Library folder: one multi-file book, one single-file book with chapters.
  tone(path.join(root, 'lib', 'Book One', '02 - Second.mp3'), 2);
  tone(path.join(root, 'lib', 'Book One', '10 - Tenth.mp3'), 1);
  tone(path.join(root, 'lib', 'Book One', '01 - First.mp3'), 1);
  writeFileSync(path.join(root, 'lib', 'Book One', 'cover.jpg'), 'not really a jpeg');
  const meta = path.join(root, 'chapters.txt');
  writeFileSync(
    meta,
    ';FFMETADATA1\ntitle=Chaptered\nartist=Some Author\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Opening\n\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=4000\ntitle=Closing\n',
  );
  tone(path.join(root, 'lib', 'Chaptered.m4b'), 4, []);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-i', meta, '-map_metadata', '1', '-map_chapters', '1',
    '-c:a', 'aac', '-f', 'mp4',
    path.join(root, 'lib', 'Chaptered.m4b'),
  ]);
  // Authors folder
  tone(path.join(root, 'authors', 'Jane Doe', 'Her Book', '1.mp3'), 1);
});

after(() => rmSync(root, { recursive: true, force: true }));

test('finds books in a library folder in natural order', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const candidates = await findCandidates({ id: 'f', path: path.join(root, 'lib'), kind: 'library' });
  assert.equal(candidates.length, 2);
  const book = candidates.find((c) => !c.isFile)!;
  assert.deepEqual(book.files.map((f) => path.basename(f)), ['01 - First.mp3', '02 - Second.mp3', '10 - Tenth.mp3']);
  assert.ok(candidates.find((c) => c.isFile && c.root.endsWith('Chaptered.m4b')));
});

test('authors folders assign the author from the folder name', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const candidates = await findCandidates({ id: 'f', path: path.join(root, 'authors'), kind: 'authors' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].author, 'Jane Doe');
  assert.equal(path.basename(candidates[0].root), 'Her Book');
});

test('reads duration and embedded chapters', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const meta = await readFileMeta(path.join(root, 'lib', 'Chaptered.m4b'));
  assert.ok(Math.abs(meta.durationMs - 4000) < 150, `duration ${meta.durationMs}`);
  assert.equal(meta.title, 'Chaptered');
  assert.equal(meta.artist, 'Some Author');
  assert.deepEqual(meta.marks.map((m) => m.title), ['Opening', 'Closing']);
  assert.ok(Math.abs(meta.marks[1].startMs - 2000) < 50, `mark at ${meta.marks[1].startMs}`);
});

test('guesses how dropped paths should be added', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  assert.equal(await guessKind(path.join(root, 'lib')), 'library');
  assert.equal(await guessKind(path.join(root, 'lib', 'Book One')), 'single');
  assert.equal(await guessKind(path.join(root, 'lib', 'Chaptered.m4b')), 'file');
  assert.equal(await guessKind(path.join(root, 'chapters.txt')), null);
  assert.equal(await guessKind(path.join(root, 'missing')), null);
});

test('track titles fall back to file names when tags do not differ', () => {
  const meta = (title: string | null): FileMeta => ({ size: 1, mtimeMs: 1, durationMs: 1, title, album: null, artist: null, marks: [] });
  assert.deepEqual(trackTitles(['/a/01.mp3', '/a/02.mp3'], [meta('Book'), meta('Book')]), ['01', '02']);
  assert.deepEqual(trackTitles(['/a/01.mp3', '/a/02.mp3'], [meta('Start'), meta('End')]), ['Start', 'End']);
  assert.equal(bookName({ folderId: 'f', root: '/a/x.m4b', isFile: true, files: ['/a/x.m4b'], author: null }, [meta(null)]), 'x');
});

test('full library scan builds books with covers and chapters', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const data = path.join(root, 'appdata');
  const library = await Library.open(data);
  await library.addFolder(path.join(root, 'lib'), 'library');
  await library.rescan();
  const { books } = library.snapshot();
  assert.equal(books.length, 2);
  const multi = books.find((b) => b.name === 'Book One')!;
  assert.equal(multi.tracks.length, 3);
  assert.deepEqual(multi.tracks.map((t) => t.title), ['01 - First', '02 - Second', '10 - Tenth']);
  assert.ok(multi.coverUrl?.startsWith('voice://app/media/'));
  assert.ok(Math.abs(multi.durationMs - 4000) < 300, `duration ${multi.durationMs}`);
  const chaptered = books.find((b) => b.name === 'Chaptered')!;
  assert.equal(chaptered.author, 'Some Author');
  assert.deepEqual(chaptersOf(chaptered).map((c) => c.title), ['Opening', 'Closing']);
  // Only library files may be served.
  assert.ok(library.isAllowed(multi.tracks[0].path));
  assert.ok(!library.isAllowed(path.join(root, 'chapters.txt')));

  // Book state survives a reopen.
  library.updateBookState(multi.id, { positionMs: 1234, trackIndex: 1 });
  library.dispose();
  await library.flush();
  const reopened = await Library.open(data);
  assert.equal(reopened.snapshot().states[multi.id].positionMs, 1234);
  assert.equal(reopened.snapshot().books.length, 2, 'books are cached for a fast start');
  reopened.dispose();
});
