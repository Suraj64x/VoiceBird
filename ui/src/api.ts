export type Voice = { id: string; name: string; default: boolean; transcript: string; duration: number; created: number; image?: number
  moods?: Record<string, { transcript: string; duration: number; created: number }>;
};
export type Folder = { id: string; name: string; created: number; image: number };
export type Word = { said: string; say: string };
export type Take = { id: string; key: string; engine: string; voiceName: string; seed: number; duration: number; created: number; label: string; peaks?: number[] };
export type Settings = {
  voice: string; engine: string; emotion: string; intensity: number; style: string;
  speed: number; pitch: number; pause: number; variation: number; seed: number; lockSeed: boolean;
  oneTake: boolean; // the whole script as one take instead of one per paragraph
  tone: string; // natural | soft | warm | bright | broadcast | deep, applied on playback and export
};
export type Project = {
  id: string; name: string; script: string; settings: Settings;
  takes: Record<string, Take[]>; picked: Record<string, string>; updated: number; folder?: string | null;
};
export type ProjectInfo = { id: string; name: string; updated: number; words: number; folder: string | null };
export type Engine = {
  id: string; name: string; licence: string; commercial: boolean; note: string; style: boolean; emotion: boolean;
  match: number; speed: number; rtf: number; // match/speed 1-5; rtf = seconds to make 1 s of audio
};
export type Preset = { name: string; emotion: string; intensity: number; style: string; speed: number; pitch: number; pause: number; variation: number; tone: string };
export type HistoryItem = {
  project: string; projectName: string; key: string; id: string; text: string; engine: string; voiceName: string;
  label: string; duration: number; created: number; picked: boolean;
};
export type Status = { device: string; engines: Engine[]; defaultEngine: string; loading: string | null };
export type Job = {
  id: string; project: string; running: boolean; total: number; done: number;
  items: { key: string; state: 'queued' | 'running' | 'done' | 'error' }[];
  message: string; error: string | null; eta: number | null;
};
export type ExportFile = { name: string; url: string; note?: string };

export const DEFAULTS: Settings = {
  voice: '', engine: '', emotion: 'friendly', intensity: 50, style: '',
  speed: 1, pitch: 0, pause: 0.6, variation: 50, seed: 1234, lockSeed: true, oneTake: false, tone: 'natural',
};

async function call<T = any>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch('/api' + url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => null);
    throw new Error(body?.detail || (r.status >= 500 ? 'The voice engine is not responding yet.' : r.statusText));
  }
  return r.json();
}
const json = (method: string) => <T = any>(url: string, body?: unknown) =>
  call<T>(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

export const api = {
  get: <T = any>(url: string) => call<T>(url),
  post: json('POST'),
  put: json('PUT'),
  patch: json('PATCH'),
  del: <T = any>(url: string) => call<T>(url, { method: 'DELETE' }),
  form: <T = any>(url: string, fd: FormData) => call<T>(url, { method: 'POST', body: fd }),
};

export const takeUrl = (project: string, take: string, tone?: string) => `/api/projects/${project}/takes/${take}.wav${tone && tone !== 'natural' ? `?tone=${tone}` : ''}`;
export const voiceUrl = (v: Voice) => `/api/voices/${v.id}/audio?v=${v.created}`;
export const voiceImg = (v: Voice) => (v.image ? `/api/voices/${v.id}/image?v=${v.image}` : '');
export const folderImg = (f: Folder) => (f.image ? `/api/folders/${f.id}/image?v=${f.image}` : '');

/** Paragraphs = blocks of text separated by blank lines. */
export const paragraphs = (script: string) =>
  script.split(/\n[ \t\u00a0]*\n+/)
    .map((p) => p.replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p)); // a line of *** or --- is not a paragraph

/** Stable id for a paragraph's text, so takes stay attached when other paragraphs move. */
export function keyOf(text: string) {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

export const clock = (s: number) => {
  if (!isFinite(s)) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

export const ago = (unix: number) => {
  const s = Date.now() / 1000 - unix;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(unix * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

// emotions, each with its colour; a voice can have its own sample for any of them
export const MOODS: [string, 'slate' | 'green' | 'amber' | 'cyan' | 'pink' | 'blue' | 'violet' | 'red'][] = [
  ['neutral', 'slate'], ['friendly', 'green'], ['excited', 'amber'], ['calm', 'cyan'], ['soft', 'pink'],
  ['serious', 'blue'], ['sad', 'violet'], ['angry', 'red'], ['whisper', 'slate'],
];
export const moodUrl = (v: Voice, mood: string) => `/api/voices/${v.id}/moods/${mood}/audio?v=${v.moods?.[mood]?.created ?? 0}`;
