// Draws the installer art crisp at every Windows display scale (100%..250%) plus the app icon.
// Run from ui/ (it borrows playwright-core and the fonts):  node ../installer/art.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.resolve(import.meta.dirname);
const OUT = path.join(HERE, 'art');
const UI = path.resolve(HERE, '../ui');
const { chromium } = createRequire(path.join(UI, 'package.json'))('playwright-core');
fs.mkdirSync(OUT, { recursive: true });
const font = (f) => pathToFileURL(path.join(UI, 'node_modules/@fontsource-variable', f)).href;
const ffmpeg = process.env.VOICECLONER_FFMPEG || 'ffmpeg';

const css = `
@font-face { font-family: Bricolage; src: url(${font('bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2')}); font-weight: 200 800; }
@font-face { font-family: Outfit; src: url(${font('outfit/files/outfit-latin-wght-normal.woff2')}); font-weight: 100 900; }
html, body { margin: 0; width: 100vw; height: 100vh; overflow: hidden; }`;
const mark = (size) => `<svg viewBox="0 0 32 32" width="${size}" height="${size}"><rect width="32" height="32" rx="7.5" fill="#2fdb73"/>
  <path d="M8 13v6M12 9v14M16 6v20M20 10v12M24 13v6" stroke="#03140a" stroke-width="2.6" stroke-linecap="round"/></svg>`;

// tall welcome panel: dark, the mark, the name, a quiet waveform
const wizard = `<style>${css}
body { background: radial-gradient(120% 60% at 50% 0%, #123524 0%, #0b1210 55%, #080b0a 100%); display: grid; place-items: center; }
.c { display: grid; justify-items: center; gap: 4vh; transform: translateY(-6vh); }
.n { font: 800 13.5vw/1 Bricolage, sans-serif; letter-spacing: -.02em; color: #ecf2ef; }
.t { font: 500 6.4vw/1.35 Outfit, sans-serif; color: #93a39c; text-align: center; padding: 0 10vw; }
.w { position: absolute; left: 0; right: 0; bottom: 7vh; display: flex; align-items: center; justify-content: center; gap: 1.4vw; height: 16vh; }
.w i { width: 2vw; border-radius: 1vw; background: linear-gradient(#2fdb73, #b197fc); opacity: .55; }
</style><div class="c">${mark('34vw')}<div class="n">VoiceBird</div><div class="t">Your voice.<br>Any script.<br>Studio-ready.</div></div>
<div class="w">${Array.from({ length: 23 }, (_, i) => `<i style="height:${(18 + 80 * Math.abs(Math.sin(i * 0.9) * Math.cos(i * 0.31))).toFixed(0)}%"></i>`).join('')}</div>`;

// header logo (transparent)
const small = `<style>${css} body { display: grid; place-items: center; background: transparent; }</style>${mark('86vmin')}`;

const WIZ = [[164, 314], [192, 386], [246, 459], [273, 556], [328, 604], [355, 700], [410, 797]];
const SMALL = [[55, 55], [64, 68], [83, 80], [92, 97], [110, 106], [119, 123], [138, 140]];
const ICON = [16, 20, 24, 32, 40, 48, 64, 128, 256];

const browser = await chromium.launch({ channel: 'msedge', headless: true });
async function render(htmlDoc, w, h, file, transparent = false) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const tmp = path.join(OUT, '_render.html');
  fs.writeFileSync(tmp, `<!doctype html><meta charset="utf-8">${htmlDoc}`);
  await page.goto(pathToFileURL(tmp).href);  // a file page, so the local fonts load
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: transparent });
  await page.close();
}
const toBmp = (png, bmp, alpha) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', png, '-pix_fmt', alpha ? 'bgra' : 'bgr24', bmp]);

const wiz = [], sm = [];
for (const [w, h] of WIZ) {
  const png = path.join(OUT, `wizard-${w}.png`); await render(wizard, w, h, png); toBmp(png, png.replace('.png', '.bmp'), false); fs.unlinkSync(png);
  wiz.push(`wizard-${w}.bmp`);
}
for (const [w, h] of SMALL) {
  const png = path.join(OUT, `small-${w}.png`); await render(small, w, h, png, true); toBmp(png, png.replace('.png', '.bmp'), true); fs.unlinkSync(png);
  sm.push(`small-${w}.bmp`);
}
// icon: PNG entries packed into one .ico (Windows Vista and later read them at every size)
const pngs = [];
for (const s of ICON) { const f = path.join(OUT, `icon-${s}.png`); await render(small.replace('86vmin', '100vmin'), s, s, f, true); pngs.push([s, fs.readFileSync(f)]); fs.unlinkSync(f); }
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let off = head.length;
pngs.forEach(([s, b], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s >= 256 ? 0 : s, e); head.writeUInt8(s >= 256 ? 0 : s, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
  head.writeUInt32LE(b.length, e + 8); head.writeUInt32LE(off, e + 12); off += b.length;
});
fs.writeFileSync(path.join(OUT, 'voicebird.ico'), Buffer.concat([head, ...pngs.map(([, b]) => b)]));
// a large preview for checking by eye
await render(wizard, 410, 797, path.join(OUT, 'preview-wizard.png'));
await browser.close();
fs.unlinkSync(path.join(OUT, '_render.html'));
console.log('wizard:', wiz.join(','));
console.log('small:', sm.join(','));
