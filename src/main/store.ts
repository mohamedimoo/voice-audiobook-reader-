import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * A tiny JSON file store. Writes are debounced and atomic (write to a temp file,
 * then rename) so a crash or power loss can never leave a half-written file.
 */
export class JsonStore<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly file: string,
    initial: T,
    private readonly delayMs: number,
  ) {
    this.value = initial;
  }

  static async open<T>(file: string, fallback: () => T, delayMs = 400): Promise<JsonStore<T>> {
    let initial: T;
    try {
      initial = JSON.parse(await fs.readFile(file, 'utf8')) as T;
    } catch {
      initial = fallback();
    }
    return new JsonStore(file, initial, delayMs);
  }

  get(): T {
    return this.value;
  }

  set(value: T): void {
    this.value = value;
    this.schedule();
  }

  update(fn: (value: T) => T | void): void {
    const result = fn(this.value);
    if (result !== undefined) this.value = result;
    this.schedule();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const data = JSON.stringify(this.value, null, 1);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, this.file);
    }).catch((err) => {
      console.error(`Failed to write ${this.file}`, err);
    });
    return this.writing;
  }
}
