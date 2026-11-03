// Bundles the main process, preload script and renderer with esbuild.
import { build } from 'esbuild';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const tests = process.argv.includes('--tests');

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
  legalComments: 'none',
};

if (tests) {
  const testDir = path.join(root, 'test');
  const entries = (await readdir(testDir)).filter((f) => f.endsWith('.test.ts')).map((f) => path.join(testDir, f));
  await rm(path.join(root, 'dist-test'), { recursive: true, force: true });
  await build({
    ...common,
    entryPoints: entries,
    outdir: path.join(root, 'dist-test'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'warning',
  });
} else {
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  await mkdir(path.join(root, 'dist', 'renderer'), { recursive: true });
  await Promise.all([
    build({
      ...common,
      entryPoints: [path.join(root, 'src/main/main.ts')],
      outfile: path.join(root, 'dist/main.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [path.join(root, 'src/preload/preload.ts')],
      outfile: path.join(root, 'dist/preload.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron'],
    }),
    build({
      ...common,
      entryPoints: [path.join(root, 'src/renderer/app.ts')],
      outfile: path.join(root, 'dist/renderer/app.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome130',
    }),
  ]);
  for (const file of ['index.html', 'styles.css']) {
    await cp(path.join(root, 'src/renderer', file), path.join(root, 'dist/renderer', file));
  }
}
