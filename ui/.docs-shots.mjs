// README screenshots: the real app with demo data (never your own voices or scripts), zoomed in,
// with handwritten notes and small hand-drawn arrows. Every API call is answered here; nothing is saved.
// Run from ui/ with the dev server up:  node .docs-shots.mjs <temp folder>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const TMP = process.argv[2];
fs.mkdirSync(DOCS, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// ---------- demo data ----------
function keyOf(text) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 2654435761); b = Math.imul(b ^ c, 1597334677); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
const now = Date.now() / 1000;
const peaks = (seed) => Array.from({ length: 96 }, (_, i) => {
  const gap = (i + seed) % 13 === 0 || (i + seed * 3) % 29 === 0 ? 0.15 : 1;
  return +(gap * (0.25 + 0.7 * Math.abs(Math.sin(i * 0.37 + seed)) * (0.45 + 0.55 * Math.abs(Math.sin(i * 0.11 + seed * 2))))).toFixed(3);
});
const status = await fetch('http://127.0.0.1:7879/api/status').then((r) => r.json());
Object.assign(status, { job: null, loading: null, device: 'GPU' });
const voices = [
  { id: 'v1', name: 'Maya', default: true, transcript: '', duration: 18, created: 1, moods: { soft: { transcript: '', duration: 12, created: 2 }, excited: { transcript: '', duration: 14, created: 3 } } },
  { id: 'v2', name: 'Leo', default: false, transcript: '', duration: 22, created: 4 },
  { id: 'v3', name: 'Narrator', default: false, transcript: '', duration: 31, created: 5 },
];
const folders = [{ id: 'f1', name: 'YouTube', created: 1, image: 0 }, { id: 'f2', name: 'Shorts', created: 2, image: 0 }];
const script = [
  "Most people pay every month for apps they could get for free. Today I'm showing you five that are just as good.",
  'Number one replaces a forty-dollar video editor. It runs in your browser, and nothing is uploaded.',
  'Stick around until the end, because the last one is my favourite.',
];
const settings = { voice: 'v1', engine: '', emotion: 'friendly', intensity: 50, style: '', speed: 1, pitch: 0, pause: 0.6, variation: 50, seed: 1234, lockSeed: true, oneTake: false, tone: 'warm' };
const take = (id, i, dur, label, s) => ({ id, key: keyOf(script[i]), engine: 'Qwen3 (closest match)', voiceName: 'Maya', seed: 1234 + s, duration: dur, created: now - 300 + s, label, peaks: peaks(s) });
const project = {
  id: 'p1', name: '5 free apps that replace paid ones', script: script.join('\n\n'), settings, folder: 'f1', updated: now - 120,
  takes: {
    [keyOf(script[0])]: [take('t1', 0, 7.4, 'Friendly 50%', 1), take('t2', 0, 7.1, 'Excited 60% · mood sample', 2)],
    [keyOf(script[1])]: [take('t3', 1, 6.2, 'Friendly 50%', 3)],
    [keyOf(script[2])]: [take('t4', 2, 4.3, 'Friendly 50%', 4)],
  },
  picked: { [keyOf(script[0])]: 't2', [keyOf(script[1])]: 't3', [keyOf(script[2])]: 't4' },
};
const list = [
  { id: 'p1', name: project.name, updated: now - 120, words: 52, folder: 'f1' },
  { id: 'p2', name: 'Weekly AI news #12', updated: now - 3600, words: 240, folder: 'f1' },
  { id: 'p3', name: '3 hidden Windows tools', updated: now - 86400, words: 85, folder: 'f2' },
  { id: 'p4', name: 'Podcast intro', updated: now - 2 * 86400, words: 60, folder: null },
  { id: 'p5', name: 'Channel trailer', updated: now - 4 * 86400, words: 118, folder: null },
];
const presets = [{ name: 'My intro', emotion: 'excited', intensity: 55, style: 'warm YouTube host', speed: 1.03, pitch: 0, pause: 0.5, variation: 55, tone: 'bright' }];
const EXPORT = {
  folder: '20261113-101500',
  files: [
    { name: '5-free-apps-master.wav', url: '/api/x/a.wav', note: '-14.0 LUFS · peak -1.0 dBTP' },
    { name: '5-free-apps-master.mp3', url: '/api/x/a.mp3', note: '-14.0 LUFS · peak -1.0 dBTP' },
    { name: '5-free-apps.srt', url: '/api/x/a.srt', note: 'subtitles' },
  ],
};
const WAV = (() => { // 20 s of silence, 8 kHz mono
  const n = 8000 * 20, b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
})();

async function demo(page, zoom = 1) {
  await page.addInitScript((z) => { localStorage.theme = 'dark'; localStorage.project = 'p1'; localStorage.closedFolders = '[]'; localStorage.uiZoom = String(z); }, zoom);
  await page.route('**/api/**', (route) => {
    const req = route.request(), p = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() !== 'GET') return json(p.endsWith('/export') ? EXPORT : project); // nothing is ever saved
    if (p === '/api/status') return json(status);
    if (p === '/api/voices') return json(voices);
    if (p === '/api/folders') return json(folders);
    if (p === '/api/projects') return json(list);
    if (p === '/api/projects/p1') return json(project);
    if (p === '/api/words') return json([]);
    if (p === '/api/presets') return json(presets);
    if (p === '/api/history') return json([]);
    if (/\.(wav|mp3)$|\/audio$/.test(p)) return route.fulfill({ contentType: 'audio/wav', body: WAV });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://localhost:7878');
  await page.getByText('Ready', { exact: true }).waitFor({ timeout: 60000 });
  await page.addStyleTag({ content: '[data-sonner-toaster]{display:none!important}' });
  await page.waitForTimeout(900);
}
const box = async (loc) => { const r = await loc.first().boundingBox(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
const rel = (r, c) => ({ x: r.x - c.x, y: r.y - c.y, w: r.w, h: r.h });
async function shoot(page, name, crop, rects) {
  const img = path.join(TMP, `${name}.png`);
  await page.screenshot({ path: img, clip: { x: crop.x, y: crop.y, width: crop.w, height: crop.h } });
  return { img, w: crop.w, h: crop.h, rects: Object.fromEntries(Object.entries(rects).map(([k, r]) => [k, rel(r, crop)])) };
}

// ---------- capture ----------
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const shots = {};
{ // the whole app, real size
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await demo(page);
  await page.getByRole('button', { name: 'Play take 2' }).first().click();
  await page.waitForTimeout(2300);
  await page.getByRole('region', { name: 'Now playing' }).getByRole('button', { name: 'Pause', exact: true }).click();
  await page.mouse.move(700, 880);
  shots.app = await shoot(page, 'app', { x: 0, y: 0, w: 1440, h: 900 }, {
    voice: await box(page.locator('aside').first().locator('li').first()),
    player: await box(page.getByRole('region', { name: 'Now playing' })),
    engine: await box(page.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio').first()),
  });
  await page.close();
}
{ // zoomed: the takes
  const page = await browser.newPage({ viewport: { width: 1760, height: 1250 }, deviceScaleFactor: 2 });
  await demo(page, 1.35);
  const main = await box(page.locator('main'));
  const takesTop = (await box(page.getByRole('radiogroup', { name: 'How to split the voice-over' }))).y - 24;
  const crop = { x: main.x, y: takesTop, w: main.w, h: main.y + main.h - takesTop };
  shots.takes = await shoot(page, 'takes', crop, {
    split: await box(page.getByRole('radiogroup', { name: 'How to split the voice-over' })),
    pick: await box(page.getByRole('button', { name: 'Take 2', exact: true })),
    redo: await box(page.locator('ol > li').first().getByRole('button', { name: 'New take' })),
    download: await box(page.getByRole('link', { name: 'Download take 2' })),
    export: await box(page.locator('footer').getByRole('button', { name: /Export/ })),
  });
  await page.close();
}
{ // zoomed: the right panel
  const page = await browser.newPage({ viewport: { width: 1440, height: 2600 }, deviceScaleFactor: 2 });
  await demo(page, 1.35);
  const aside = await box(page.locator('aside').last());
  const tone = await box(page.getByRole('radiogroup', { name: 'Tone' }));
  const voiceTop = (await box(page.getByRole('radiogroup', { name: 'Engine' }))).y - 16;
  const crop = { x: aside.x, y: voiceTop, w: aside.w, h: tone.y + tone.h + 20 - voiceTop };
  shots.panel = await shoot(page, 'panel', crop, {
    best: await box(page.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio').first()),
    fast: await box(page.getByRole('radiogroup', { name: 'Engine' }).getByRole('radio').nth(1)),
    styles: await box(page.getByRole('button', { name: 'Soft & gentle' })),
    mood: await box(page.locator('[aria-label="mood sample"]').first()),
    tone: await box(page.getByRole('radio', { name: 'Warm' })),
  });
  await page.close();
}
{ // zoomed: export
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 2 });
  await demo(page, 1.35);
  await page.getByRole('tab', { name: 'Export' }).click();
  await page.locator('aside').last().getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForTimeout(700);
  const insp = page.locator('aside').last();
  const aside = await box(insp);
  const files = await box(insp.locator('ul, ol').last());
  const top = (await box(insp.locator('section').first())).y - 10;
  const crop = { x: aside.x, y: top, w: aside.w, h: files.y + files.h + 16 - top };
  shots.export = await shoot(page, 'export', crop, {
    format: await box(insp.getByRole('button', { name: 'MP3' })),
    master: await box(insp.getByRole('switch').first()),
    srt: await box(insp.locator('li', { hasText: '.srt' })),
    play: await box(insp.locator('li', { hasText: 'master.mp3' }).getByRole('button').first()),
  });
  await page.close();
}

// ---------- handwritten notes ----------
// [rect, side of the image the note sits on, text, tilt (deg), vertical/horizontal nudge]
const NOTES = {
  app: { k: 0.62, pad: { l: 120, r: 660, t: 140, b: 60 }, notes: [
    ['player', 'top', 'keeps playing while you switch projects', -1.5],
    ['engine', 'right', 'the engine that sounds most like you', 2],
  ] },
  takes: { k: 0.8, pad: { l: 440, r: 440, t: 130, b: 50 }, notes: [
    ['split', 'top', 'the whole script in one take, or line by line', -1.5],
    ['pick', 'left', 'compare takes, keep the best', -2],
    ['redo', 'right', 'redo only this line', 2],
  ] },
  panel: { k: 0.9, pad: { l: 120, r: 560, t: 40, b: 40 }, notes: [
    ['best', 'right', 'closest match to your voice', 2],
    ['mood', 'right', 'your own recorded mood = real emotion', -2],
    ['tone', 'right', 'tone changes instantly, no re-render', 2],
  ] },
  export: { k: 0.9, pad: { l: 120, r: 560, t: 40, b: 40 }, notes: [
    ['master', 'right', 'YouTube loudness, automatically', 2],
    ['srt', 'right', 'subtitles with word timings', -2],
  ] },
};

function html(name) {
  const s = shots[name], c = NOTES[name], k = c.k, P = c.pad;
  const W = Math.round(s.w * k + P.l + P.r), H = Math.round(s.h * k + P.t + P.b);
  const img = `data:image/png;base64,${fs.readFileSync(s.img).toString('base64')}`;
  const notes = c.notes.map(([key, side, text, tilt, nudge = 0]) => {
    const r = s.rects[key];
    return { side, text, tilt, nudge, r: { x: P.l + r.x * k, y: P.t + r.y * k, w: r.w * k, h: r.h * k } };
  });
  return `<!doctype html><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=block" rel="stylesheet">
<style>
html, body { margin: 0; background: #0b0f0e; }
#c { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; background: #0b0f0e; }
#shot { position: absolute; left: ${P.l}px; top: ${P.t}px; width: ${s.w * k}px; height: ${s.h * k}px; border-radius: 12px;
  box-shadow: 0 0 0 1px #28322e, 0 30px 70px rgba(0,0,0,.55); }
.n { position: absolute; font: 700 50px/1.05 Caveat, cursive; color: #f4f7f5; white-space: nowrap; transform-origin: center; text-shadow: 0 2px 14px rgba(0,0,0,.6); }
svg { position: absolute; inset: 0; overflow: visible; }
</style>
<div id="c"><img id="shot" src="${img}"><svg id="svg" width="${W}" height="${H}"></svg></div>
<script>
const W = ${W}, H = ${H}, P = ${JSON.stringify(P)}, notes = ${JSON.stringify(notes)};
const c = document.getElementById('c'), svg = document.getElementById('svg'), NS = 'http://www.w3.org/2000/svg';
let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5);
const line = (d, w = 3.2) => { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', d); e.setAttribute('fill', 'none');
  e.setAttribute('stroke', '#f4f7f5'); e.setAttribute('stroke-width', w); e.setAttribute('stroke-linecap', 'round'); e.setAttribute('stroke-linejoin', 'round'); svg.appendChild(e); };
function arrow(sx, sy, ex, ey) { // a little hand-drawn arrow: gentle curve, slight wobble, open head
  const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy), bend = -Math.min(28, len * 0.18);
  const mx = (sx + ex) / 2 - dy / len * bend, my = (sy + ey) / 2 + dx / len * bend;
  line('M' + sx + ' ' + sy + ' Q' + (mx + rnd() * 3) + ' ' + (my + rnd() * 3) + ' ' + ex + ' ' + ey);
  const a = Math.atan2(ey - my, ex - mx), h = 16;
  for (const s of [-1, 1]) line('M' + ex + ' ' + ey + ' L' + (ex - h * Math.cos(a + s * 0.5) + rnd() * 2) + ' ' + (ey - h * Math.sin(a + s * 0.5) + rnd() * 2));
}
for (const n of notes) { const d = document.createElement('div'); d.className = 'n'; d.textContent = n.text; c.appendChild(d); n.el = d; }
document.fonts.ready.then(() => {
  for (const n of notes) {
    const room = n.side === 'left' ? P.l - 100 : n.side === 'right' ? P.r - 100 : W - 40;
    for (let size = 50; n.el.offsetWidth > room && size > 34; size -= 2) n.el.style.fontSize = size + 'px';
    const w = n.el.offsetWidth, h = n.el.offsetHeight, r = n.r, cx = r.x + r.w / 2, cy = r.y + r.h / 2 + n.nudge;
    let x, y, sx, sy, ex, ey;
    if (n.side === 'left') { x = P.l - 70 - w; y = cy - h / 2; sx = x + w + 8; sy = cy; ex = r.x - 12; ey = r.y + r.h / 2; }
    if (n.side === 'right') { x = P.l + ${s.w * k} + 70; y = cy - h / 2; sx = x - 8; sy = cy; ex = r.x + r.w + 12; ey = r.y + r.h / 2; }
    if (n.side === 'top') { x = Math.min(Math.max(16, cx - w / 2 - 60), W - 16 - w); y = Math.max(12, P.t - h - 30); sx = x + w * 0.62; sy = y + h + 4; ex = cx; ey = r.y - 8; }
    if (n.side === 'bottom') { x = Math.min(Math.max(16, cx - w / 2 - 80), W - 16 - w); y = H - h - 14; sx = x + w * 0.66; sy = y - 4; ex = cx; ey = r.y + r.h + 8; }
    Object.assign(n.el.style, { left: x + 'px', top: y + 'px', transform: 'rotate(' + n.tilt + 'deg)' });
    arrow(sx, sy, ex, ey);
  }
  document.body.dataset.ready = '1';
});
</script>`;
}

for (const name of Object.keys(shots)) {
  const f = path.join(TMP, `${name}.html`);
  fs.writeFileSync(f, html(name));
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1.5 });
  await page.goto(pathToFileURL(f).href);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await page.locator('#c').screenshot({ path: path.join(DOCS, `${name}.png`) });
  await page.close();
  console.log('wrote docs/' + name + '.png');
}
await browser.close();
