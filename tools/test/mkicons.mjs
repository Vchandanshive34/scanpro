/**
 * Rasterise the app icon into the PNG sizes the manifest needs.
 *
 *   node tools/test/mkicons.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICONS = path.join(ROOT, 'icons');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const svg = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');
const browser = await chromium.launch({ executablePath: CHROME });

const SIZES = [
  ['icon-192', 192, false],
  ['icon-512', 512, false],
  ['icon-maskable', 512, true],
];

for (const [name, size, maskable] of SIZES) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });

  // Maskable icons must keep their art inside the safe zone, since launchers
  // crop them to whatever shape the platform uses.
  const inset = maskable ? 'transform:scale(.72);' : '';
  const sized = svg.replace('width="512" height="512"', `width="${size}" height="${size}"`);

  await page.setContent(
    `<body style="margin:0;background:${maskable ? '#12141c' : 'transparent'};` +
    `width:${size}px;height:${size}px;display:grid;place-items:center;overflow:hidden">` +
    `<div style="width:${size}px;height:${size}px;${inset}">${sized}</div></body>`);

  await page.screenshot({
    path: path.join(ICONS, `${name}.png`),
    omitBackground: !maskable,
  });
  await page.close();
}

await browser.close();
console.log(`icons rendered into ${ICONS}`);
