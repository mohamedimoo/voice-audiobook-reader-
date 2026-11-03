import { bookPositionMs, chapterAt, chaptersOf, locate, type Chapter } from '../shared/chapters';
import type { Book, BookState } from '../shared/types';

export type SleepTimer =
  | { kind: 'off' }
  | { kind: 'time'; endsAt: number; minutes: number }
  | { kind: 'chapter'; chapterIndex: number };

export interface PlayerOptions {
  autoRewindMs: () => number;
  sleepFadeOut: () => boolean;
  /** Called (throttled) whenever the listening position should be persisted. */
  persist: (bookId: string, patch: Partial<BookState>) => void;
}

const SILENCE_THRESHOLD = 0.004; // RMS amplitude, roughly -48 dBFS
const SILENCE_MIN_MS = 300;
const SILENCE_RATE = 4; // Chromium mutes audio above 4x anyway
const FADE_MS = 10_000;
const PERSIST_EVERY_MS = 3000;

/**
 * Audio engine: plays a book track by track, keeps the position, and implements
 * the listening features (speed, skip silence, volume boost, sleep timer...).
 */
export class Player {
  readonly audio = new Audio();
  book: Book | null = null;
  chapters: Chapter[] = [];
  trackIndex = 0;
  speed = 1;
  skipSilence = false;
  gainDb = 0;
  sleep: SleepTimer = { kind: 'off' };
  error: string | null = null;

  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private fadeNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuffer: Float32Array<ArrayBuffer> | null = null;
  private silenceSince: number | null = null;
  private inSilence = false;
  private pendingSeekMs: number | null = null;
  private pausedAt: number | null = null;
  private lastPersist = 0;
  private lastPersisted = '';
  private listeners = new Set<() => void>();
  private timeListeners = new Set<() => void>();
  private tickTimer: number | null = null;
  private artwork: { coverUrl: string; blobUrl: string | null } | null = null;

  constructor(private readonly options: PlayerOptions) {
    this.audio.preload = 'auto';
    this.audio.preservesPitch = true;
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.pendingSeekMs !== null) {
        this.audio.currentTime = this.pendingSeekMs / 1000;
        this.pendingSeekMs = null;
      }
      this.applyRate();
    });
    this.audio.addEventListener('timeupdate', () => this.onTime());
    this.audio.addEventListener('play', () => this.changed());
    this.audio.addEventListener('pause', () => {
      this.persistNow();
      this.changed();
    });
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => {
      const err = this.audio.error;
      if (!this.audio.src || !err) return;
      this.error = `Could not play “${this.track?.title ?? 'file'}” (${err.message || `error ${err.code}`}).`;
      this.changed();
    });
    this.tickTimer = window.setInterval(() => this.tick(), 50);
  }

  // ---------------------------------------------------------------- subscriptions

  /** Fires on state changes (play / pause / track / settings). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Fires frequently while the position advances. */
  subscribeTime(fn: () => void): () => void {
    this.timeListeners.add(fn);
    return () => this.timeListeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
    this.updateMediaSession();
  }

  // ---------------------------------------------------------------- getters

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get track() {
    return this.book?.tracks[this.trackIndex] ?? null;
  }

  /** Position inside the current track. */
  get positionMs(): number {
    if (this.pendingSeekMs !== null) return this.pendingSeekMs;
    return Math.round(this.audio.currentTime * 1000);
  }

  get bookPositionMs(): number {
    return this.book ? bookPositionMs(this.book, this.trackIndex, this.positionMs) : 0;
  }

  get chapter(): Chapter | null {
    return chapterAt(this.chapters, this.trackIndex, this.positionMs);
  }

  // ---------------------------------------------------------------- loading

  load(book: Book, state: BookState) {
    if (this.book && this.book.id !== book.id) this.persistNow();
    const sameBook = this.book?.id === book.id;
    this.book = book;
    this.chapters = chaptersOf(book);
    this.speed = state.speed;
    this.skipSilence = state.skipSilence;
    this.gainDb = state.gainDb;
    this.error = null;
    if (!sameBook) {
      // Switching books never carries playback over to the new one.
      if (this.playing) this.audio.pause();
      this.sleepOff();
      const trackIndex = Math.min(Math.max(0, state.trackIndex), book.tracks.length - 1);
      const position = state.completed ? 0 : state.positionMs;
      this.setTrack(trackIndex, position);
      this.pausedAt = null;
    } else {
      // The library was rescanned: keep playing, but refresh the URLs if needed.
      const track = book.tracks[this.trackIndex];
      if (!track) this.setTrack(0, 0);
    }
    this.applyGain();
    this.applyRate();
    this.changed();
  }

  unload() {
    this.persistNow();
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.book = null;
    this.chapters = [];
    this.sleepOff();
    this.changed();
  }

  private setTrack(index: number, positionMs: number) {
    const track = this.book?.tracks[index];
    if (!track) return;
    const wasPlaying = this.playing;
    if (index !== this.trackIndex || !this.audio.src || this.audio.src !== track.url) {
      this.trackIndex = index;
      this.pendingSeekMs = positionMs;
      this.audio.src = track.url;
      this.audio.load();
      if (wasPlaying) void this.audio.play().catch(() => {});
    } else {
      this.seekWithinTrack(positionMs);
    }
  }

  private seekWithinTrack(positionMs: number) {
    if (this.audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      this.audio.currentTime = positionMs / 1000;
      this.pendingSeekMs = null;
    } else {
      this.pendingSeekMs = positionMs;
    }
  }

  // ---------------------------------------------------------------- transport

  async play() {
    if (!this.book) return;
    this.ensureGraph();
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
    const state = this.book;
    const finishedAtEnd = this.audio.ended && this.trackIndex === state.tracks.length - 1;
    if (finishedAtEnd) {
      this.setTrack(0, 0);
    } else if (this.pausedAt !== null) {
      const rewind = this.options.autoRewindMs();
      if (rewind > 0) this.seekBook(this.bookPositionMs - rewind);
    }
    this.pausedAt = null;
    this.error = null;
    this.restoreFade();
    this.applyRate();
    try {
      await this.audio.play();
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.error = `Playback failed: ${(err as Error).message}`;
        this.changed();
      }
    }
  }

  pause() {
    if (!this.playing) return;
    this.audio.pause();
    this.pausedAt = Date.now();
  }

  toggle() {
    if (this.playing) this.pause();
    else void this.play();
  }

  /** Seek to a position inside the whole book. */
  seekBook(bookMs: number) {
    if (!this.book) return;
    const clamped = Math.max(0, Math.min(bookMs, Math.max(0, this.book.durationMs - 500)));
    const { trackIndex, positionMs } = locate(this.book, clamped);
    this.setTrack(trackIndex, positionMs);
    this.afterSeek();
  }

  seekTrack(trackIndex: number, positionMs: number) {
    this.setTrack(trackIndex, positionMs);
    this.afterSeek();
  }

  skip(deltaMs: number) {
    this.seekBook(this.bookPositionMs + deltaMs);
  }

  nextChapter() {
    const current = this.chapter;
    if (!current) return;
    const next = this.chapters[current.index + 1];
    if (next) this.seekTrack(next.trackIndex, next.startMs);
  }

  previousChapter() {
    const current = this.chapter;
    if (!current) return;
    const intoChapter = this.positionMs - current.startMs;
    const target = intoChapter > 3000 || current.index === 0 ? current : this.chapters[current.index - 1];
    this.seekTrack(target.trackIndex, target.startMs);
  }

  private afterSeek() {
    this.silenceSince = null;
    this.pausedAt = null; // an explicit seek should not be followed by an auto-rewind
    this.persistNow();
    this.emitTime();
    this.changed();
  }

  private onEnded() {
    if (!this.book) return;
    if (this.trackIndex + 1 < this.book.tracks.length) {
      this.trackIndex++;
      const track = this.book.tracks[this.trackIndex];
      this.pendingSeekMs = 0;
      this.audio.src = track.url;
      this.audio.load();
      void this.audio.play().catch(() => {});
      this.changed();
    } else {
      // Finished the book.
      this.options.persist(this.book.id, {
        trackIndex: 0,
        positionMs: 0,
        completed: true,
        lastPlayedAt: Date.now(),
      });
      this.sleepOff();
      this.changed();
    }
  }

  // ---------------------------------------------------------------- settings

  setSpeed(speed: number) {
    this.speed = Math.round(Math.min(3.5, Math.max(0.5, speed)) * 100) / 100;
    this.applyRate();
    if (this.book) this.options.persist(this.book.id, { speed: this.speed });
    this.changed();
  }

  setSkipSilence(enabled: boolean) {
    this.skipSilence = enabled;
    if (enabled) this.ensureGraph();
    this.inSilence = false;
    this.silenceSince = null;
    this.applyRate();
    if (this.book) this.options.persist(this.book.id, { skipSilence: enabled });
    this.changed();
  }

  setGainDb(db: number) {
    this.gainDb = Math.min(12, Math.max(0, db));
    if (db > 0) this.ensureGraph();
    this.applyGain();
    if (this.book) this.options.persist(this.book.id, { gainDb: this.gainDb });
    this.changed();
  }

  private applyRate() {
    const rate = this.skipSilence && this.inSilence ? Math.max(SILENCE_RATE, this.speed) : this.speed;
    if (this.audio.playbackRate !== rate) this.audio.playbackRate = rate;
    if (this.audio.defaultPlaybackRate !== this.speed) this.audio.defaultPlaybackRate = this.speed;
  }

  private applyGain() {
    if (this.gainNode) this.gainNode.gain.value = Math.pow(10, this.gainDb / 20);
  }

  /** Routes the audio element through Web Audio (needed for volume boost and silence detection). */
  private ensureGraph() {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      const source = this.ctx.createMediaElementSource(this.audio);
      this.gainNode = this.ctx.createGain();
      this.fadeNode = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyserBuffer = new Float32Array(this.analyser.fftSize);
      source.connect(this.analyser);
      source.connect(this.gainNode);
      this.gainNode.connect(this.fadeNode);
      this.fadeNode.connect(this.ctx.destination);
      this.applyGain();
    } catch (err) {
      console.error('Web Audio unavailable', err);
      this.ctx = null;
    }
  }

  // ---------------------------------------------------------------- sleep timer

  setSleepMinutes(minutes: number) {
    this.sleep = { kind: 'time', minutes, endsAt: Date.now() + minutes * 60_000 };
    this.restoreFade();
    this.changed();
  }

  setSleepEndOfChapter() {
    const chapter = this.chapter;
    if (!chapter) return;
    this.sleep = { kind: 'chapter', chapterIndex: chapter.index };
    this.restoreFade();
    this.changed();
  }

  extendSleep(minutes: number) {
    if (this.sleep.kind !== 'time') return this.setSleepMinutes(minutes);
    this.sleep = { ...this.sleep, endsAt: Math.max(this.sleep.endsAt, Date.now()) + minutes * 60_000 };
    this.restoreFade();
    this.changed();
  }

  sleepOff() {
    if (this.sleep.kind === 'off') return;
    this.sleep = { kind: 'off' };
    this.restoreFade();
    this.changed();
  }

  get sleepRemainingMs(): number | null {
    return this.sleep.kind === 'time' ? Math.max(0, this.sleep.endsAt - Date.now()) : null;
  }

  private restoreFade() {
    if (this.fadeNode) this.fadeNode.gain.value = 1;
    this.audio.volume = 1;
  }

  private sleepFired() {
    this.sleep = { kind: 'off' };
    this.pause();
    this.restoreFade();
    this.changed();
  }

  // ---------------------------------------------------------------- periodic work

  private tick() {
    if (!this.book) return;
    const now = Date.now();

    // Sleep timer
    if (this.sleep.kind === 'time' && this.playing) {
      const remaining = this.sleep.endsAt - now;
      if (remaining <= 0) {
        this.sleepFired();
      } else if (this.options.sleepFadeOut() && remaining < FADE_MS) {
        const level = Math.max(0, remaining / FADE_MS);
        if (this.fadeNode) this.fadeNode.gain.value = level;
        else this.audio.volume = level;
      }
    }

    // Skip silence
    if (this.skipSilence && this.playing && this.analyser && this.analyserBuffer) {
      this.analyser.getFloatTimeDomainData(this.analyserBuffer);
      let sum = 0;
      for (const v of this.analyserBuffer) sum += v * v;
      const rms = Math.sqrt(sum / this.analyserBuffer.length);
      if (rms < SILENCE_THRESHOLD) {
        this.silenceSince ??= now;
        if (!this.inSilence && now - this.silenceSince >= SILENCE_MIN_MS) {
          this.inSilence = true;
          this.applyRate();
        }
      } else {
        this.silenceSince = null;
        if (this.inSilence) {
          this.inSilence = false;
          this.applyRate();
        }
      }
    } else if (this.inSilence) {
      this.inSilence = false;
      this.applyRate();
    }
  }

  private onTime() {
    if (!this.book) return;
    if (this.sleep.kind === 'chapter' && this.playing) {
      const chapter = this.chapter;
      if (chapter && chapter.index !== this.sleep.chapterIndex) {
        // The chapter ended: stop at the beginning of the next one.
        this.sleepFired();
        this.seekTrack(chapter.trackIndex, chapter.startMs);
      }
    }
    if (Date.now() - this.lastPersist > PERSIST_EVERY_MS && this.playing) this.persistNow();
    this.emitTime();
  }

  private emitTime() {
    for (const fn of this.timeListeners) fn();
    this.updatePositionState();
  }

  persistNow() {
    if (!this.book || !this.audio.src) return;
    if (this.audio.ended && this.trackIndex === this.book.tracks.length - 1) return; // finished: keep "completed"
    this.lastPersist = Date.now();
    // Only write when the position actually moved, so explicit state changes
    // (e.g. "mark as finished") are not overwritten by a stale position.
    const key = `${this.book.id}|${this.trackIndex}|${this.positionMs}`;
    if (key === this.lastPersisted) return;
    this.lastPersisted = key;
    this.options.persist(this.book.id, {
      trackIndex: this.trackIndex,
      positionMs: this.positionMs,
      lastPlayedAt: Date.now(),
      completed: false,
    });
  }

  // ---------------------------------------------------------------- OS integration

  private updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const book = this.book;
    if (!book) {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
      return;
    }
    const chapter = this.chapter;
    const artwork = this.artwork?.coverUrl === book.coverUrl && this.artwork.blobUrl ? [{ src: this.artwork.blobUrl, sizes: '512x512' }] : [];
    if (book.coverUrl && this.artwork?.coverUrl !== book.coverUrl) void this.loadArtwork(book.coverUrl);
    const current = navigator.mediaSession.metadata;
    const title = chapter && this.chapters.length > 1 ? chapter.title : book.name;
    if (!current || current.title !== title || current.album !== book.name || current.artwork.length !== artwork.length) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: book.author ?? '',
        album: book.name,
        artwork,
      });
    }
    navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
  }

  /** The OS media overlay only accepts http(s), data and blob artwork URLs. */
  private async loadArtwork(coverUrl: string) {
    if (this.artwork?.blobUrl) URL.revokeObjectURL(this.artwork.blobUrl);
    this.artwork = { coverUrl, blobUrl: null };
    try {
      const blob = await (await fetch(coverUrl)).blob();
      if (this.artwork?.coverUrl !== coverUrl) return;
      this.artwork.blobUrl = URL.createObjectURL(blob);
      navigator.mediaSession.metadata = null; // force a refresh with the artwork
      this.updateMediaSession();
    } catch {
      /* no artwork */
    }
  }

  private updatePositionState() {
    if (!('mediaSession' in navigator) || !this.book) return;
    const chapter = this.chapter;
    if (!chapter) return;
    const duration = (chapter.endMs - chapter.startMs) / 1000;
    const position = (this.positionMs - chapter.startMs) / 1000;
    if (!(duration > 0) || position < 0 || position > duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration, position, playbackRate: this.speed });
    } catch {
      /* ignore invalid states during track changes */
    }
  }

  dispose() {
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
  }
}
