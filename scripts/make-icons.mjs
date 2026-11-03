// Renders the app / tray / taskbar icons from SVG to PNG using Playwright's Chromium.
// Run with `npm run icons` (requires the `playwright` package and a Chromium build).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADPHONES =
  'M12 3a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h1a2 2 0 0 0 2-2v-4a2 2 0 0 0-2-2H5a7 7 0 0 1 14 0h-2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9Z';

const appIcon = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffc66e"/>
      <stop offset="1" stop-color="#e0703a"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/>
  <g transform="translate(40 40) scale(7.333)" fill="#2a1c05"><path d="${HEADPHONES}"/></g>
  <rect x="114" y="150" width="7" height="34" rx="3.5" fill="#2a1c05"/>
  <rect x="125" y="140" width="7" height="54" rx="3.5" fill="#2a1c05"/>
  <rect x="136" y="154" width="7" height="26" rx="3.5" fill="#2a1c05"/>
</svg>`;

const glyph = (d, size = 32, color = '#ffffff') => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><path fill="${color}" d="${d}"/></svg>`;

const GLYPHS = {
  'thumb-play': 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14Z',
  'thumb-pause': 'M7 4.5h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Zm7 0h3a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z',
  'thumb-previous': 'M6 5a1 1 0 0 1 1 1v4.6l9.47-5.92A1 1 0 0 1 18 5.53v12.94a1 1 0 0 1-1.53.85L7 13.4V18a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Z',
  'thumb-next': 'M18 5a1 1 0 0 0-1 1v4.6L7.53 4.68A1 1 0 0 0 6 5.53v12.94a1 1 0 0 0 1.53.85L17 13.4V18a1 1 0 1 0 2 0V6a1 1 0 0 0-1-1Z',
  'thumb-rewind': 'M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z',
  'thumb-forward': 'M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8Z',
};

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size, out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  const png = await page.locator('svg').screenshot({ omitBackground: true });
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, png);
  console.log('wrote', path.relative(root, out));
}

await render(appIcon(512), 512, path.join(root, 'build/icon.png'));
await render(appIcon(256), 256, path.join(root, 'build/assets/icon.png'));
await render(appIcon(32), 32, path.join(root, 'build/assets/tray.png'));
for (const [name, d] of Object.entries(GLYPHS)) {
  await render(glyph(d, 32), 32, path.join(root, `build/assets/${name}.png`));
}
await browser.close();
