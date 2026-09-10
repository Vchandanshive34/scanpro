/**
 * Live-camera test.
 *
 * Feeds Chromium a synthetic video of a document on a desk and checks that the
 * viewfinder detects the page, draws the outline, arms the shutter and fires
 * auto-capture on its own.
 */
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE || 'http://localhost:8099';
const OUT = process.env.OUT || HERE;
const FEED = path.join(HERE, 'fake_camera.y4m');

// The fake camera feed is a 159 MB raw video, so it is generated on demand
// from the test photo rather than kept in the repo.
if (!fs.existsSync(FEED)) {
  console.log('Generating the fake camera feed (needs ffmpeg)…');
  execSync(
    `ffmpeg -loglevel error -y -loop 1 -i "${path.join(HERE, 'test_photo.jpg')}" ` +
    `-t 6 -r 15 -vf "scale=720:960,pad=1280:960:(1280-720)/2:0:color=0x3a2e24,format=yuv420p" ` +
    `"${FEED}"`,
    { stdio: 'inherit' });
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${FEED}`,
  ],
});

const context = await browser.newContext({
  viewport: { width: 412, height: 900 },
  deviceScaleFactor: 2,
  permissions: ['camera'],
  hasTouch: true, isMobile: true,
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

console.log('\n=== Live camera with a simulated document ===');

await page.locator('#btn-open-camera').click();

// The pipeline is fast enough that auto-capture can fire within a couple of
// seconds, so sample continuously and keep the peak rather than reading once.
const peak = { videoW: 0, playing: false, corners: false, confidence: 0, stable: 0 };
let hint = '';
let overlayPainted = 0;

for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(200);

  const snap = await page.evaluate(() => {
    const v = document.querySelector('#camera-video');
    const c = window.__scanproCamera;
    const canvas = document.querySelector('#camera-overlay');

    let painted = 0;
    if (canvas && canvas.width) {
      const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      for (let j = 3; j < d.length; j += 4 * 40) if (d[j] > 8) painted++;
    }

    return {
      videoW: v ? v.videoWidth : 0,
      playing: v ? !v.paused : false,
      corners: !!(c && c.corners),
      confidence: c ? c.confidence : 0,
      stable: c ? c.stableCount : 0,
      hint: document.querySelector('#camera-hint').textContent,
      painted,
      inEditor: !document.querySelector('#screen-editor').hidden,
    };
  });

  peak.videoW = Math.max(peak.videoW, snap.videoW);
  peak.playing = peak.playing || snap.playing;
  peak.corners = peak.corners || snap.corners;
  peak.confidence = Math.max(peak.confidence, snap.confidence);
  peak.stable = Math.max(peak.stable, snap.stable);
  overlayPainted = Math.max(overlayPainted, snap.painted);
  if (snap.hint) hint = snap.hint;

  if (snap.inEditor) break;
}

check('camera stream running', peak.videoW > 0 && peak.playing, `${peak.videoW}px wide`);
check('page detected in the live viewfinder', peak.corners,
  peak.corners ? `peak confidence ${peak.confidence.toFixed(2)}` : 'no quad');
check('detection is stable across frames', peak.stable >= 2,
  `${peak.stable} steady frames before capture`);
check('viewfinder guidance shown', hint.length > 0, `"${hint}"`);
check('edge outline drawn on the viewfinder', overlayPainted > 0,
  `${overlayPainted} sampled pixels painted`);

await page.screenshot({ path: `${OUT}/ui-camera-live.png` });

// Auto-capture should carry us into the editor without a tap.
await page.waitForTimeout(3000);
const wentToEditor = await page.locator('#screen-editor').isVisible();
const batchCount = await page.locator('#batch-count').innerText().catch(() => '0');

check('auto-capture fired without a tap',
  wentToEditor || Number(batchCount) > 0,
  wentToEditor ? 'editor opened on its own' : `batch ${batchCount}`);

if (wentToEditor) await page.screenshot({ path: `${OUT}/ui-editor-live.png` });

check('no page errors during camera use', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
