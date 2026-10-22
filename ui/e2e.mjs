// End-to-end click-through of every feature in a real browser (your installed Edge, headless).
// The app must be running (start.bat). From the ui folder:
//     node e2e.mjs [engine name fragment, default "sopro"]
// Screenshots land in tests/shots/. It creates and removes its own voices and project.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const URL = 'http://localhost:7878';
const ROOT = path.resolve(import.meta.dirname, '..');
const SHOTS = path.join(ROOT, 'tests', 'shots');
const ENGINE = new RegExp(process.argv[2] || 'sopro', 'i');
const LONG = 20 * 60 * 1000;
fs.mkdirSync(SHOTS, { recursive: true });

const sample = fs.readdirSync(path.join(ROOT, 'voices'), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => path.join(ROOT, 'voices', d.name))
  .flatMap((d) => fs.readdirSync(d).filter((f) => f.startsWith('source.')).map((f) => path.join(d, f)))[0];

const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, permissions: ['microphone'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/502|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));

const results = [];
let n = 0;
async function step(name, fn) {
  n += 1;
  const t = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note });
    console.log(`ok   ${String(n).padStart(2)} ${name}${note ? ` (${note})` : ''} [${((Date.now() - t) / 1000).toFixed(1)} s]`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message.split('\n')[0] });
    console.log(`FAIL ${String(n).padStart(2)} ${name}: ${e.message.split('\n')[0]}`);
    await page.screenshot({ path: path.join(SHOTS, `fail-${n}.png`) }).catch(() => {});
  }
}
const shot = (name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const dialog = () => page.getByRole('dialog');
const footer = () => page.locator('footer');
const inspector = () => page.locator('aside').last();
const toast = (text) => page.getByText(text).first().waitFor({ timeout: 60000 });

async function saveVoice(name) {
  await page.locator('#vName').fill(name);
  await dialog().locator('label', { hasText: 'I own this voice' }).getByRole('checkbox').click();
  await dialog().getByRole('button', { name: 'Save voice' }).click();
  await page.getByRole('button', { name: `Options for ${name}` }).waitFor({ timeout: 120000 });
}
const voiceMenu = async (name, item) => {
  await page.getByRole('button', { name: `Options for ${name}` }).click();
  await page.getByRole('menuitem', { name: item }).click();
};

await step('app loads and reports Ready', async () => {
  await page.goto(URL);
  await page.getByText('Ready', { exact: true }).waitFor({ timeout: 5 * 60 * 1000 });
  await page.getByRole('button', { name: 'Options for Jason' }).waitFor();
  await shot('01-home');
});

await step('Jason is the default voice', async () => {
  const voices = await page.evaluate(() => fetch('/api/voices').then((r) => r.json()));
  const d = voices.find((v) => v.default);
  expect(d?.name === 'Jason', `default voice is ${d?.name}`);
  return `sample ${d.duration} s`;
});

await step('upload a sample, trim it on the waveform, save as a voice', async () => {
  await page.getByRole('button', { name: 'New voice' }).first().click();
  await dialog().locator('input[type=file]').setInputFiles(sample);
  const wave = dialog().locator('canvas');
  await wave.waitFor();
  const box = await wave.boundingBox();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);   // drag the end handle left
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const end = +(await dialog().locator('input[type=number]').nth(1).inputValue());
  expect(end > 5 && end < 10, `end handle did not move as expected (end = ${end})`);
  await dialog().getByRole('button', { name: 'Play' }).click();
  await shot('02-new-voice');
  await saveVoice('E2E Upload');
  const v = (await page.evaluate(() => fetch('/api/voices').then((r) => r.json()))).find((x) => x.name === 'E2E Upload');
  expect(Math.abs(v.duration - end) < 0.8, `saved sample is ${v.duration} s, expected about ${end} s`);
  expect(v.transcript.length > 20, 'no automatic transcript');
  return `trimmed to ${v.duration} s, transcript "${v.transcript.slice(0, 40)}…"`;
});

await step('record a sample from the microphone and save it', async () => {
  await page.getByRole('button', { name: 'New voice' }).first().click();
  await dialog().getByRole('button', { name: 'Record' }).click();
  await page.waitForTimeout(4000);
  await dialog().getByRole('button', { name: 'Stop' }).click();
  await dialog().locator('canvas').waitFor();
  await saveVoice('E2E Record');
  const v = (await page.evaluate(() => fetch('/api/voices').then((r) => r.json()))).find((x) => x.name === 'E2E Record');
  return `recorded ${v.duration} s (fake microphone)`;
});

await step('saving is blocked without the permission checkbox', async () => {
  await page.getByRole('button', { name: 'New voice' }).first().click();
  await dialog().locator('input[type=file]').setInputFiles(sample);
  await page.locator('#vName').fill('No consent');
  expect(await dialog().getByRole('button', { name: 'Save voice' }).isDisabled(), 'Save was enabled without consent');
  await dialog().getByRole('button', { name: 'Cancel' }).click();
});

await step('preview, rename, set default and delete voices', async () => {
  await page.getByRole('button', { name: 'Play E2E Upload sample' }).click();
  await page.getByRole('button', { name: 'Pause E2E Upload sample' }).waitFor();
  await page.getByRole('button', { name: 'Pause E2E Upload sample' }).click();
  await voiceMenu('E2E Upload', 'Rename');
  await dialog().getByLabel('Name').fill('E2E Renamed');
  await dialog().getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Options for E2E Renamed' }).waitFor();
  await voiceMenu('E2E Renamed', 'Set as default');
  await page.waitForFunction(() => fetch('/api/voices').then((r) => r.json()).then((v) => v.find((x) => x.default)?.name === 'E2E Renamed'));
  await voiceMenu('Jason', 'Set as default');
  await page.waitForFunction(() => fetch('/api/voices').then((r) => r.json()).then((v) => v.find((x) => x.default)?.name === 'Jason'));
  for (const name of ['E2E Renamed', 'E2E Record']) {
    await voiceMenu(name, 'Delete');
    await dialog().getByRole('button', { name: 'Delete voice' }).click();
    await page.getByRole('button', { name: `Options for ${name}` }).waitFor({ state: 'detached' });
  }
  const left = await page.evaluate(() => fetch('/api/voices').then((r) => r.json()));
  expect(left.length >= 1 && left.every((v) => !v.name.startsWith('E2E')), 'test voices were not removed');
});

await step('new project: title, script, live counts, autosave', async () => {
  const before = await page.evaluate(() => localStorage.project);
  await page.getByRole('button', { name: 'New project' }).click();
  await page.waitForFunction((b) => localStorage.project && localStorage.project !== b, before); // never type into the project that was open before
  await page.getByLabel('Project name').fill('E2E test');
  await page.getByLabel('Script', { exact: true }).fill('Most people pay every month for apps they could get for free.\n\nSounds too good to be true, right? Stick around until the end.');
  await page.getByText('Saved').waitFor();
  await page.getByText('0/2', { exact: true }).waitFor();  // two paragraphs found, none generated yet
  const p = (await page.evaluate(() => fetch('/api/projects').then((r) => r.json()))).find((x) => x.name === 'E2E test');
  expect(p?.words === 24, `saved project has ${p?.words} words`);
});

await step('controls: emotion, intensity, style, pace, pitch, pause, expressiveness, seed, lock, reset', async () => {
  await page.getByRole('radio', { name: 'excited' }).click();
  for (const [id, key, times] of [['intensity', 'ArrowRight', 2], ['speed', 'ArrowRight', 5], ['pitch', 'ArrowLeft', 2], ['pause', 'ArrowRight', 2], ['variation', 'ArrowLeft', 1]]) {
    await page.locator(`#${id} [role=slider], [role=slider]#${id}`).first().focus();
    for (let i = 0; i < times; i++) await page.keyboard.press(key);
  }
  await page.getByLabel('Style prompt').fill('hyped YouTube host, smiling');
  await page.locator('#seed').fill('42');
  await page.getByRole('button', { name: 'New random seed' }).click();
  const seed = await page.locator('#seed').inputValue();
  await page.locator('label', { hasText: 'Lock seed' }).getByRole('switch').click();
  await page.getByText('Saved').waitFor();
  const id = await page.evaluate(() => localStorage.project);
  let s = (await page.evaluate((i) => fetch(`/api/projects/${i}`).then((r) => r.json()), id)).settings;
  expect(s.emotion === 'excited' && s.intensity === 60 && Math.abs(s.speed - 1.05) < 1e-6 && s.pitch === -1 && Math.abs(s.pause - 0.7) < 1e-6 && s.variation === 45
    && s.style.startsWith('hyped') && String(s.seed) === seed && s.seed !== 42 && s.lockSeed === false, `settings not saved as set: ${JSON.stringify(s)}`);
  await shot('03-controls');
  await page.getByRole('button', { name: 'Reset controls' }).click();
  await page.waitForTimeout(1200);
  s = (await page.evaluate((i) => fetch(`/api/projects/${i}`).then((r) => r.json()), id)).settings;
  expect(s.emotion === 'friendly' && s.speed === 1 && s.pitch === 0 && s.lockSeed === true, 'reset did not restore the defaults');
});

await step('pick the engine from the dropdown', async () => {
  const group = page.getByRole('radiogroup', { name: 'Engine' });
  const names = await group.getByRole('radio').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  await group.getByRole('radio', { name: ENGINE }).first().click();
  return `engines offered: ${names.join(' | ')}`;
});

await step('generate the whole script (queue + progress)', async () => {
  await footer().getByRole('button', { name: /^Generate/ }).click();
  await footer().getByRole('progressbar').waitFor({ timeout: 60000 });
  await shot('04-generating');
  await page.waitForFunction(() => document.querySelectorAll('ol > li [role=slider]').length >= 2, null, { timeout: LONG });
  await toast('Voice-over ready');
  await shot('05-takes');
});

await step('regenerate one paragraph, A/B the takes, play, delete a take', async () => {
  const first = page.locator('ol > li').first();
  await first.getByRole('button', { name: 'New take' }).click();
  await first.getByRole('button', { name: 'Take 2', exact: true }).waitFor({ timeout: LONG });
  expect(await page.locator('ol > li').nth(1).getByRole('button', { name: /^Take/ }).count() === 1, 'the other paragraph was regenerated too');
  expect(await first.getByRole('button', { name: 'Take 2', exact: true }).getAttribute('aria-pressed') === 'true', 'newest take is not selected');
  await first.getByRole('button', { name: 'Take 1', exact: true }).click();
  expect(await first.getByRole('button', { name: 'Take 1', exact: true }).getAttribute('aria-pressed') === 'true', 'could not pick take 1');
  await first.getByRole('button', { name: 'Play take 1' }).click();
  await first.getByRole('button', { name: 'Pause take 1' }).waitFor({ timeout: 15000 });
  await page.getByRole('region', { name: 'Now playing' }).waitFor();
  await first.getByRole('button', { name: 'Pause take 1' }).click();
  await shot('06-ab-takes');
  await first.getByRole('button', { name: 'Delete take 2' }).click();
  await first.getByRole('button', { name: 'Take 2', exact: true }).waitFor({ state: 'detached' });
});

await step('export: WAV + MP3, one file + per paragraph, YouTube master, subtitles', async () => {
  await footer().getByRole('button', { name: 'Export' }).click();
  await inspector().getByRole('button', { name: 'Per paragraph' }).click();
  await inspector().locator('label', { hasText: 'Subtitles' }).getByRole('switch').click();
  await shot('07-export-options');
  await inspector().getByRole('button', { name: 'Export', exact: true }).click();
  await toast('Export finished');
  const names = await inspector().locator('a[download]').evaluateAll((as) => as.map((a) => a.getAttribute('download')));
  for (const want of ['E2E-test-master.wav', 'E2E-test-master.mp3', 'E2E-test-p01-master.wav', 'E2E-test-p02-master.mp3', 'E2E-test.srt', 'E2E-test.words.json'])
    expect(names.includes(want), `missing export file ${want} (got ${names.join(', ')})`);
  const [download] = await Promise.all([page.waitForEvent('download'), inspector().locator('a[download="E2E-test-master.mp3"]').click()]);
  const saved = path.join(SHOTS, 'e2e-download.mp3');
  await download.saveAs(saved);
  expect(fs.statSync(saved).size > 10000, 'downloaded MP3 is empty');
  const note = await inspector().locator('li', { hasText: 'E2E-test-master.wav' }).first().innerText();
  await shot('08-exported');
  return note.replace(/\s+/g, ' ').slice(0, 80);
});

await step('stop a running job', async () => {
  await footer().getByRole('button', { name: 'New take for every paragraph' }).click();
  await footer().getByRole('button', { name: 'Stop' }).click();
  await toast('Stopped');
});

await step('light theme', async () => {
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  expect(!(await page.evaluate(() => document.documentElement.classList.contains('dark'))), 'still dark');
  await inspector().getByRole('tab', { name: 'Voice' }).click();
  await shot('09-light');
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
});

await step('projects list: switch back and forth, then delete the test project', async () => {
  const rows = page.locator('aside').first().locator('li[draggable]');
  expect(await rows.count() >= 2, 'expected at least two projects in the list');
  await rows.nth(1).locator('button').first().click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Project name"]').value !== 'E2E test');
  await rows.filter({ hasText: 'E2E test' }).locator('button').first().click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Project name"]').value === 'E2E test');
  expect(await page.locator('ol > li').first().getByRole('button', { name: /^Take/ }).count() >= 1, 'takes were not kept in the project');
  await page.getByRole('button', { name: 'Options for E2E test' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await dialog().getByRole('button', { name: 'Delete project' }).click();
  await page.waitForFunction(() => fetch('/api/projects').then((r) => r.json()).then((p) => !p.some((x) => x.name === 'E2E test')));
});

await step('phone-size layout has no sideways scroll', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  await shot('10-phone');
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(over <= 1, `page is ${over}px wider than the screen`);
});

await browser.close();
const bad = results.filter((r) => !r.ok);
if (errors.length) console.log('\nBrowser errors:\n  ' + [...new Set(errors)].slice(0, 10).join('\n  '));
console.log(`\n${results.length - bad.length}/${results.length} steps passed`);
fs.writeFileSync(path.join(SHOTS, 'e2e-results.json'), JSON.stringify({ results, errors: [...new Set(errors)] }, null, 1));
process.exit(bad.length ? 1 : 0);
