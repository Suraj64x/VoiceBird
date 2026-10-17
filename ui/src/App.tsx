import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { ArrowsClockwise, Check, CircleNotch, ClockCounterClockwise, FileArrowUp, DownloadSimple, Equalizer, Faders, FileAudio, FileText, Files, FolderOpen, IconContext, Moon, Playlist, Stop, Subtitles, Sun, TextAa, Trash, Waveform, YoutubeLogo } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Toaster } from '@/components/ui/sonner';
import { Switch } from '@/components/ui/switch';
import { api, clock, DEFAULTS, keyOf, paragraphs, takeUrl, type ExportFile, type Folder, type Job, type Project, type ProjectInfo, type Settings, type Status, type Take, type Voice } from '@/api';
import { ScriptToSound, Section, Toggle } from '@/components/bits';
import { Controls } from '@/components/Controls';
import { ImageCrop, type CropTarget } from '@/components/ImageCrop';
import { Library, type Ask, type Rename } from '@/components/Library';
import { NowPlaying, Player } from '@/components/Player';
import { VoiceDialog } from '@/components/VoiceDialog';
import { MoodDialog } from '@/components/MoodDialog';
import { Words } from '@/components/Words';
import { History } from '@/components/History';
import { cn } from '@/lib/utils';

/** A stable function that always calls the latest version (keeps memoised rows from re-rendering). */
function useEvent<A extends unknown[], R>(fn: (...a: A) => R) {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...a: A) => ref.current(...a), []);
}

function Stat({ value, label, text }: { value?: number; text?: string; label: string }) {
  return (
    <div className="shrink-0 max-sm:hidden max-sm:first:block">
      <div className="flex h-6 items-center font-display text-xl font-extrabold leading-none tabular-nums">{text ?? <NumberFlow value={value ?? 0} />}</div>
      <div className="text-[11px] leading-4 text-muted-foreground">{label}</div>
    </div>
  );
}

/** One paragraph with its takes. Memoised: typing elsewhere in the script does not redraw it. */
const ParaRow = memo(function ParaRow({ n, text, k, takes, picked, state, busy, pid, pname, tone, onGen, onPick, onDrop }: {
  n: number; text: string; k: string; takes: Take[]; picked?: string; state?: string; busy: boolean; pid: string; pname: string; tone: string;
  onGen: (key: string, text: string) => void; onPick: (key: string, take: string) => void; onDrop: (take: string) => void;
}) {
  return (
    <li className="grid gap-2 border-t px-5 py-4 lg:px-9">
      <div className="flex items-start gap-3">
        <span className="mt-[3px] w-5 shrink-0 font-mono text-xs font-semibold tabular-nums text-muted-foreground">{String(n).padStart(2, '0')}</span>
        <p className="min-w-0 flex-1 whitespace-pre-line text-[15px] leading-relaxed">{text}</p>
        {state === 'running' ? (
          <span className="flex h-8 shrink-0 items-center gap-2 text-[13px] font-medium text-success"><span className="levels"><i /><i /><i /></span>Speaking</span>
        ) : state === 'queued' ? (
          <span className="flex h-8 shrink-0 items-center text-[13px] text-muted-foreground">Queued</span>
        ) : (
          <Button variant="outline" size="sm" className="h-8 shrink-0" disabled={busy} onClick={() => onGen(k, text)}>
            <ArrowsClockwise weight="bold" /> {takes.length ? 'New take' : 'Generate'}
          </Button>
        )}
      </div>
      {takes.map((t, i) => {
        const sel = picked === t.id;
        return (
          <div key={t.id} className={cn('ml-8 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border p-1.5 transition-colors', sel ? 'hue-green border-hue bg-hue-soft' : 'hover:bg-muted/60')}>
            <Button variant={sel ? 'default' : 'outline'} size="sm" className="h-8 px-2.5 font-semibold" aria-pressed={sel} title={sel ? 'This take is used' : 'Use this take'} onClick={() => onPick(k, t.id)}>
              {sel && <Check weight="bold" />}Take {i + 1}
            </Button>
            <Player src={takeUrl(pid, t.id, tone)} peaks={t.peaks} duration={t.duration} label={`take ${i + 1}`} title={`Paragraph ${n} · Take ${i + 1}`} sub={pname || 'Untitled script'} className="min-w-[200px] flex-1" />
            <span className="hidden text-xs text-muted-foreground sm:inline" title={`${t.engine} · ${t.voiceName} · seed ${t.seed}`}>{t.label}</span>
            <Button asChild variant="ghost" size="icon" className="size-8 text-muted-foreground">
              <a href={takeUrl(pid, t.id)} download={`p${String(n).padStart(2, '0')}-take${i + 1}.wav`} aria-label={`Download take ${i + 1}`} title="Download this take"><DownloadSimple weight="bold" /></a>
            </Button>
            <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Delete take ${i + 1}`} title={`Delete take ${i + 1}`} onClick={() => onDrop(t.id)}><Trash weight="bold" /></Button>
          </div>
        );
      })}
    </li>
  );
});

/** two soft notes when a voice-over is ready */
function chime() {
  try {
    const a = new AudioContext();
    const t0 = a.currentTime;
    [660, 880].forEach((f, i) => {
      const o = a.createOscillator(), g = a.createGain(), t = t0 + i * 0.13;
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g).connect(a.destination);
      o.start(t);
      o.stop(t + 0.45);
    });
    setTimeout(() => a.close(), 1200);
  } catch { /* no audio output */ }
}

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [status, setStatus] = useState<(Status & { job: Job | null }) | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [voiceDlg, setVoiceDlg] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [rename, setRename] = useState<Rename | null>(null);
  const [crop, setCrop] = useState<CropTarget | null>(null);
  const [moodFor, setMoodFor] = useState<string | null>(null);
  const [tab, setTab] = useState<'voice' | 'words' | 'export' | 'history'>('voice');
  const [exp, setExp] = useState({ wav: true, mp3: true, combined: true, paragraphs: false, master: true, srt: false });
  const [exporting, setExporting] = useState(false);
  const [files, setFiles] = useState<{ files: ExportFile[]; folder: string } | null>(null);
  const [saved, setSaved] = useState(true);
  const [retry, setRetry] = useState(0);
  const pid = useRef<string | null>(null);
  const dirty = useRef(false);
  const lastJob = useRef('');
  const lastStatus = useRef('');
  const inspector = useRef<HTMLElement>(null);

  const job = status?.job ?? null;
  const running = !!job?.running;
  const mine = job && project && job.project === project.id ? job : null;

  // ---------- loading ----------
  const loadVoices = useCallback(() => api.get<Voice[]>('/voices').then(setVoices), []);
  const loadLibrary = useCallback(() => Promise.all([api.get<ProjectInfo[]>('/projects').then(setProjects), api.get<Folder[]>('/folders').then(setFolders)]), []);

  const projRef = useRef(project);
  projRef.current = project;
  const open = useCallback(async (id: string) => {
    const cur = projRef.current; // save unsaved typing before switching
    if (dirty.current && cur) await api.put(`/projects/${cur.id}`, { name: cur.name, script: cur.script, settings: cur.settings }).catch(() => {});
    const p = await api.get<Project>(`/projects/${id}`);
    p.settings = { ...DEFAULTS, ...p.settings };
    pid.current = p.id;
    try { localStorage.project = p.id; } catch { /* private mode */ }
    dirty.current = false;
    setFiles(null);
    setSaved(true);
    setProject(p);
  }, []);

  const create = useCallback(async (folder: string | null = null) => {
    const p = await api.post<Project>('/projects', { name: 'Untitled script', folder });
    await loadLibrary();
    await open(p.id);
  }, [loadLibrary, open]);

  const refreshTakes = useCallback(async () => {
    if (!pid.current) return;
    const p = await api.get<Project>(`/projects/${pid.current}`);
    setProject((cur) => (cur && cur.id === p.id ? { ...cur, takes: p.takes, picked: p.picked } : cur));
  }, []);

  // first load, once the backend answers
  const ready = !!status;
  useEffect(() => {
    if (!ready) return;
    (async () => {
      await Promise.all([loadVoices(), api.get<Folder[]>('/folders').then(setFolders)]);
      const list = await api.get<ProjectInfo[]>('/projects');
      setProjects(list);
      let last = '';
      try { last = localStorage.project; } catch { /* private mode */ }
      const want = list.find((p) => p.id === last) ?? list[0];
      want ? await open(want.id) : await create();
    })().catch((e) => toast.error(e.message));
  }, [ready]); // eslint-disable-line

  // poll status + job (fast while generating); only redraw when something changed
  const fast = useRef(false);
  fast.current = running;
  useEffect(() => {
    let timer: number, stop = false;
    const tick = async () => {
      try {
        const raw = await fetch('/api/status').then((r) => { if (!r.ok) throw new Error(); return r.text(); });
        if (raw !== lastStatus.current) {
          lastStatus.current = raw;
          const s = JSON.parse(raw) as Status & { job: Job | null };
          const sig = s.job ? `${s.job.id}:${s.job.done}:${s.job.running}` : '';
          if (sig !== lastJob.current) {
            const was = lastJob.current;
            lastJob.current = sig;
            if (was || s.job) refreshTakes();
            if (s.job && !s.job.running && was.endsWith(':true')) {
              s.job.error ? toast.error(s.job.error) : toast.success(s.job.message === 'Stopped' ? 'Stopped' : 'Voice-over ready');
              if (!s.job.error && s.job.message !== 'Stopped') chime();
              loadLibrary();
            }
          }
          setStatus(s);
        }
      } catch {
        lastStatus.current = '';
        setStatus(null);
      }
      if (!stop) timer = window.setTimeout(tick, fast.current ? 800 : 3000);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [refreshTakes, loadLibrary]);

  // autosave name / script / settings
  const edit = (patch: Partial<Project>) => {
    dirty.current = true;
    setSaved(false);
    setProject((p) => (p ? { ...p, ...patch } : p));
  };
  const importText = useEvent(async (f?: File | null) => {
    if (!f || !project) return;
    if (!/\.(txt|md)$/i.test(f.name) && !f.type.startsWith('text/')) { toast.error('Pick a .txt or .md file'); return; }
    const t = (await f.text()).replace(/\r\n/g, '\n').trim();
    const named = !project.name || project.name === 'Untitled script';
    edit({ script: project.script.trim() ? `${project.script.trimEnd()}\n\n${t}` : t, ...(named ? { name: f.name.replace(/\.\w+$/, '') } : {}) });
    toast.success(`Added ${f.name}`);
  });
  // the browser tab shows progress, so you can work elsewhere while it speaks
  useEffect(() => {
    document.title = job?.running ? `● ${job.eta ? `${clock(job.eta)} left` : 'Generating'} · VoiceBird` : 'VoiceBird';
  }, [job?.running, job?.eta]);
  const setS = useEvent((patch: Partial<Settings>) => project && edit({ settings: { ...project.settings, ...patch } }));
  useEffect(() => {
    if (!project || !dirty.current) return;
    const t = setTimeout(async () => {
      dirty.current = false;
      try {
        await api.put(`/projects/${project.id}`, { name: project.name, script: project.script, settings: project.settings });
        setSaved(true);
        loadLibrary();
      } catch (e: any) {
        dirty.current = true;
        toast.error(`Could not save: ${e.message}`);
        setTimeout(() => setRetry((r) => r + 1), 3000); // try again until it works
      }
    }, 600);
    return () => clearTimeout(t);
  }, [project?.name, project?.script, project?.settings, retry]); // eslint-disable-line

  // ---------- derived ----------
  const paras = useMemo(() => {
    const seen = new Map<string, number>(); // the same text twice still gets two separate keys
    const list = paragraphs(project?.script ?? '');
    if (project?.settings.oneTake && list.length) { const text = list.join('\n\n'); return [{ text, key: keyOf(`one:${text}`) }]; }
    return list.map((text) => {
      const n = seen.get(text) ?? 0;
      seen.set(text, n + 1);
      return { text, key: keyOf(n ? `${text}#${n}` : text) };
    });
  }, [project?.script, project?.settings.oneTake]);
  const words = useMemo(() => (project?.script.match(/\S+/g) || []).length, [project?.script]);
  const missing = paras.filter((p) => !(project?.takes[p.key]?.length));
  const allDone = paras.length > 0 && missing.length === 0;
  const pct = mine && mine.total ? Math.round((mine.done / mine.total) * 100) : 0;
  const stateOf = (key: string) => (mine?.running ? mine.items.find((i) => i.key === key)?.state : undefined);
  const picks = allDone && project ? paras.map((p) => project.picked[p.key] ?? project.takes[p.key].at(-1)!.id) : [];
  const engineNow = status?.engines.find((e) => e.id === project?.settings.engine) ?? status?.engines.find((e) => e.id === status?.defaultEngine);
  const makeTime = useMemo(() => { // rough: speaking time of what's missing x the engine's speed, plus loading
    const w = missing.reduce((n, p) => n + (p.text.match(/\S+/g) || []).length, 0);
    return w ? (w / 2.6) * (engineNow?.rtf ?? 2) + 10 : 0;
  }, [missing, engineNow]);
  const length = useMemo(() => {  // real length once every paragraph has a take, else a reading-speed guess
    if (!project || !allDone) return words / 2.6;
    const takes = paras.map((p) => project.takes[p.key].find((t) => t.id === project.picked[p.key]) ?? project.takes[p.key].at(-1)!);
    return takes.reduce((s, t) => s + t.duration, 0) + project.settings.pause * (takes.length - 1);
  }, [project, paras, allDone, words]);

  // ---------- actions ----------
  const guard = (fn: () => Promise<unknown>) => fn().catch((e) => toast.error(e.message));

  const generate = useEvent((items: { key: string; text: string }[]) => guard(async () => {
    if (!project) return;
    if (!voices.length) return void toast.error('Add a voice first.');
    if (!items.length) return void toast.error('Write something first.');
    const j = await api.post<Job>(`/projects/${project.id}/generate`, { items, settings: project.settings });
    lastJob.current = `${j.id}:0:true`; // so a job that ends at once still gets its message
    lastStatus.current = '';
    setStatus((s) => s && { ...s, job: j });
  }));
  const genOne = useEvent((key: string, text: string) => generate([{ key, text }]));

  const pick = useEvent((key: string, take: string) => guard(async () => {
    setProject((p) => p && { ...p, picked: { ...p.picked, [key]: take } });
    await api.post(`/projects/${project!.id}/pick`, { key, take });
  }));

  const dropTake = useEvent((take: string) => guard(async () => {
    await api.del(`/projects/${project!.id}/takes/${take}`);
    await refreshTakes();
  }));

  // Ctrl+Enter = generate what is missing
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !running && missing.length) { e.preventDefault(); generate(missing); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const doExport = () => guard(async () => {
    if (!project) return;
    if (!exp.wav && !exp.mp3) return void toast.error('Pick WAV or MP3.');
    if (!exp.combined && !exp.paragraphs) return void toast.error('Pick one file, per paragraph, or both.');
    setExporting(true);
    try {
      const r = await api.post<{ files: ExportFile[]; folder: string }>(`/projects/${project.id}/export`, { ...exp, pause: project.settings.pause, tone: project.settings.tone, keys: paras.map((p) => p.key) });
      setFiles(r);
      toast.success('Export finished');
    } finally {
      setExporting(false);
    }
  });

  const showExport = () => {
    setTab('export');
    inspector.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  const toggleTheme = () => {
    const d = !dark;
    document.documentElement.classList.toggle('dark', d);
    try { localStorage.theme = d ? 'dark' : 'light'; } catch { /* private mode */ }
    setDark(d);
  };

  const onDeleted = (id: string) => {
    if (id !== pid.current) return;
    guard(async () => {
      const list = await api.get<ProjectInfo[]>('/projects');
      list[0] ? await open(list[0].id) : await create();
    });
  };

  const activeVoice = project && voices.some((v) => v.id === project.settings.voice) ? project.settings.voice : voices.find((v) => v.default)?.id;
  const state = !status ? ['Starting', 'wait'] : status.loading ? [status.loading, 'wait'] : !status.engines.length ? ['No engine installed', 'wait'] : ['Ready', 'ok'];

  return (
    <IconContext.Provider value={{ weight: 'bold' }}>
      <div className="flex min-h-full flex-col lg:h-full lg:overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-header px-4">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"><Waveform className="size-[18px]" /></span>
          <span className="font-display text-[19px] font-extrabold tracking-tight max-sm:hidden">VoiceBird</span>
          <div className="flex min-w-0 flex-1 justify-center px-1 sm:px-3"><NowPlaying /></div>
          <span className="flex h-7 items-center gap-2 rounded-md border px-2.5 text-xs font-medium text-muted-foreground" title="Everything runs on this PC">
            <span className={cn('size-2 rounded-full', state[1] === 'ok' ? 'bg-success' : 'animate-pulse bg-[var(--amber)]')} />{state[0]}
          </span>
          <Button variant="ghost" size="icon" className="size-8" onClick={toggleTheme} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[272px_minmax(0,1fr)_320px]">
          <Library
            voices={voices} activeVoice={activeVoice} onUseVoice={(id) => setS({ voice: id })} onNewVoice={() => setVoiceDlg(true)} onMoods={(v) => setMoodFor(v.id)} reloadVoices={loadVoices}
            folders={folders} projects={projects} current={project?.id} reload={loadLibrary}
            onOpen={(id) => guard(() => open(id))} onCreate={(f) => guard(() => create(f))} onRenameCurrent={(name) => edit({ name })} onDeleted={onDeleted}
            ask={setAsk} rename={setRename} crop={setCrop}
          />

          {/* ---------- middle: script, takes, action bar ---------- */}
          <main className="flex min-h-0 min-w-0 flex-col bg-background">
            <div className="min-h-0 flex-1 lg:overflow-y-auto">
              <div className="flex items-center gap-3 px-5 pt-5 lg:px-9 lg:pt-7">
                <input aria-label="Project name" className="min-w-0 flex-1 truncate bg-transparent font-display text-[32px] font-extrabold leading-tight tracking-tight outline-none placeholder:text-muted-foreground/80"
                  placeholder="Untitled script" value={project?.name ?? ''} onChange={(e) => edit({ name: e.target.value })} />
                {project && (
                  <label className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" title="Import a .txt or .md file (or drop it on the script)">
                    <FileArrowUp weight="bold" className="size-[18px]" />
                    <input type="file" accept=".txt,.md,text/plain,text/markdown" className="sr-only" aria-label="Import text file" onChange={(e) => { importText(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                )}
                {project && (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
                    {saved ? <Check className="size-3.5 text-success" /> : <CircleNotch className="size-3.5 animate-spin" />}{saved ? 'Saved' : 'Saving'}
                  </span>
                )}
              </div>
              <textarea aria-label="Script" spellCheck onDrop={(e) => { const f = e.dataTransfer.files[0]; if (f) { e.preventDefault(); importText(f); } }}
                className="block min-h-[240px] w-full max-w-[84ch] resize-none bg-transparent px-5 py-4 text-[17px] leading-[1.75] outline-none [field-sizing:content] placeholder:text-muted-foreground/80 lg:px-9"
                placeholder={'Paste your script.\n\nBlank line = pause.'}
                value={project?.script ?? ''} onChange={(e) => edit({ script: e.target.value })} />

              <div className="border-t">
                <header className="flex h-12 items-center gap-2 px-5 lg:px-9">
                  <Playlist className="size-[18px] text-success" />
                  <h2 className="font-display text-[17px] font-extrabold tracking-tight">Takes</h2>
                  {paras.length > 0 && <span className="font-mono text-xs tabular-nums text-muted-foreground">{paras.length - missing.length}/{paras.length}</span>}
                  <div role="radiogroup" aria-label="How to split the voice-over" className="ml-auto flex rounded-md border p-0.5 text-[13px] font-semibold">
                    {([[false, 'By paragraph'], [true, 'One take']] as const).map(([v, label]) => {
                      const on = !!project?.settings.oneTake === v;
                      return (
                        <button key={label} type="button" role="radio" aria-checked={on} disabled={!project || running} onClick={() => setS({ oneTake: v })}
                          className={cn('h-7 rounded-[4px] px-2.5 transition-colors disabled:opacity-50', on ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>{label}</button>
                      );
                    })}
                  </div>
                </header>
                {paras.length === 0 ? (
                  <div className="grid justify-items-center gap-4 px-5 pb-12 pt-6 text-center">
                    <ScriptToSound />
                    <p className="font-display text-xl font-extrabold tracking-tight">Script in. Voice-over out.</p>
                  </div>
                ) : (
                  <ol>
                    {project && paras.map((p, i) => (
                      <ParaRow key={p.key + i} n={i + 1} text={p.text} k={p.key} takes={project.takes[p.key] ?? NONE} picked={project.picked[p.key]}
                        state={stateOf(p.key)} busy={running || !status} pid={project.id} pname={project.name} tone={project.settings.tone} onGen={genOne} onPick={pick} onDrop={dropTake} />
                    ))}
                  </ol>
                )}
              </div>
            </div>

            <footer className="sticky bottom-0 z-10 shrink-0 border-t bg-header">
              {mine?.running && <div className="absolute inset-x-0 top-0 h-0.5 bg-input" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${Math.max(3, pct)}%` }} /></div>}
              <div className="flex h-16 items-center gap-3 px-4 sm:gap-5 sm:px-5 lg:px-9">
                <Stat value={words} label="words" />
                <Stat value={paras.length} label="paragraphs" />
                <Stat text={clock(length)} label={allDone ? 'length' : 'about'} />
                {!allDone && !running && makeTime > 0 && <Stat text={`~${clock(makeTime)}`} label="to make" />}
                <span className="min-w-0 grow truncate text-right text-[13px] text-muted-foreground" aria-live="polite">
                  {mine?.running ? `${mine.message}${mine.eta != null && mine.eta > 0 ? ` · ${clock(mine.eta)} left` : ''}` : ''}
                </span>
                {running ? (
                  <Button variant="outline" className="h-10" onClick={() => guard(() => api.post('/job/cancel'))}><Stop weight="fill" /> Stop</Button>
                ) : allDone && project ? (
                  <>
                    <Player compact preload="none" label="all paragraphs" title="Whole voice-over" sub={project.name || 'Untitled script'}
                      src={`/api/projects/${project.id}/preview.wav?keys=${paras.map((p) => p.key).join(',')}&pause=${project.settings.pause}&tone=${project.settings.tone || ''}&v=${keyOf(picks.join(','))}`} />
                    <Button variant="outline" size="icon" className="size-10" aria-label="New take for every paragraph" title="New take for every paragraph" onClick={() => generate(paras)}><ArrowsClockwise /></Button>
                  </>
                ) : null}
                {allDone && !running ? (
                  <Button className="h-10 px-5 text-[15px] font-bold" onClick={showExport}><DownloadSimple /> Export</Button>
                ) : (
                  <Button className="h-10 px-5 text-[15px] font-bold" title="Ctrl+Enter" disabled={running || !status?.engines.length || !paras.length} onClick={() => generate(missing)}>
                    {running ? <CircleNotch className="animate-spin" /> : <Waveform />}
                    {running ? 'Generating' : missing.length < paras.length ? `Generate ${missing.length} new` : 'Generate'}
                  </Button>
                )}
              </div>
            </footer>
          </main>

          {/* ---------- right: inspector ---------- */}
          <aside ref={inspector} className="quiet-scroll overflow-x-hidden border-t bg-background lg:overflow-y-auto lg:border-l lg:border-t-0">
            <div role="tablist" aria-label="Inspector" className="sticky top-0 z-10 grid grid-cols-4 gap-1 border-b bg-background p-2">
              {([['voice', 'Voice', Faders], ['words', 'Words', TextAa], ['export', 'Export', DownloadSimple], ['history', 'History', ClockCounterClockwise]] as const).map(([id, label, Icon]) => (
                <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                  className={cn('flex h-9 items-center justify-center gap-1 rounded-md text-[13px] font-semibold transition-colors', tab === id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                  <Icon className="size-4" />{label}
                </button>
              ))}
            </div>
            {tab === 'voice' && project && <Controls s={project.settings} set={setS} voices={voices} engines={status?.engines ?? NONE_E} defaultEngine={status?.defaultEngine ?? ''} onMoods={(v) => setMoodFor(v.id)} />}
            {tab === 'words' && <Words />}
            {tab === 'history' && <History onOpen={(id) => guard(() => open(id))} refresh={status?.job?.id + String(status?.job?.running)} />}
            {tab === 'export' && (
              <>
                <Section icon={Files} title="Files" hue="blue">
                  <div className="grid grid-cols-2 gap-1.5">
                    <Toggle on={exp.wav} onChange={(on) => setExp((e) => ({ ...e, wav: on }))}>WAV</Toggle>
                    <Toggle on={exp.mp3} onChange={(on) => setExp((e) => ({ ...e, mp3: on }))}>MP3</Toggle>
                    <Toggle on={exp.combined} onChange={(on) => setExp((e) => ({ ...e, combined: on }))}>One file</Toggle>
                    <Toggle on={exp.paragraphs} onChange={(on) => setExp((e) => ({ ...e, paragraphs: on }))}>Per paragraph</Toggle>
                  </div>
                </Section>
                <Section icon={Equalizer} title="Finish" hue="amber" info={<>
                  <p><b>YouTube master</b> sets the loudness YouTube expects (−14 LUFS, peaks under −1 dB) and trims long silences.</p>
                  <p><b>Subtitles</b> adds an SRT file and exact word timings, made by listening to the result.</p></>}>
                  <div className="grid gap-3">
                    <label className="hue-red flex items-center gap-3">
                      <YoutubeLogo weight="fill" className="size-6 shrink-0 text-hue" />
                      <span className="grow text-[15px] font-semibold">YouTube master</span>
                      <Switch checked={exp.master} onCheckedChange={(c) => setExp((e) => ({ ...e, master: c }))} />
                    </label>
                    <label className="hue-cyan flex items-center gap-3">
                      <Subtitles weight="fill" className="size-6 shrink-0 text-hue" />
                      <span className="grow text-[15px] font-semibold">Subtitles</span>
                      <Switch checked={exp.srt} onCheckedChange={(c) => setExp((e) => ({ ...e, srt: c }))} />
                    </label>
                  </div>
                </Section>
                <div className="grid gap-3 p-4">
                  <Button className="h-10 text-[15px] font-bold" disabled={exporting || running || !allDone} onClick={doExport}>
                    {exporting ? <CircleNotch className="animate-spin" /> : <DownloadSimple />}{exporting ? 'Exporting' : 'Export'}
                  </Button>
                  {files && (
                    <ul className="grid gap-2">
                      {files.files.map((f) => (
                        <li key={f.url} className="grid gap-1.5 rounded-md border p-2">
                          <a className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold hover:text-success" href={f.url} download={f.name}>
                            {/\.(wav|mp3)$/.test(f.name) ? <FileAudio weight="duotone" className="size-5 shrink-0 text-[var(--blue)]" /> : <FileText weight="duotone" className="size-5 shrink-0 text-[var(--cyan)]" />}
                            <span className="truncate">{f.name}</span><DownloadSimple className="ml-auto size-4 shrink-0 text-muted-foreground" />
                          </a>
                          {f.note && <span className="font-mono text-[11px] text-muted-foreground">{f.note}</span>}
                          {/\.(wav|mp3)$/.test(f.name) && <Player src={f.url} label={f.name} sub={project?.name} />}
                        </li>
                      ))}
                      <li className="flex items-start gap-1.5 text-xs text-muted-foreground"><FolderOpen className="mt-0.5 size-4 shrink-0" /><code className="break-all font-mono text-[11px]">{files.folder}</code></li>
                    </ul>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>

        <VoiceDialog open={voiceDlg} onOpenChange={setVoiceDlg} onSaved={() => loadVoices()} />
        <ImageCrop target={crop} onClose={() => setCrop(null)} />

        <Dialog open={!!ask} onOpenChange={(o) => !o && setAsk(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader><DialogTitle>{ask?.title}</DialogTitle><DialogDescription>{ask?.body}</DialogDescription></DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAsk(null)}>Cancel</Button>
              {ask?.alt && <Button variant="outline" onClick={() => { ask.alt!.run(); setAsk(null); }}>{ask.alt.label}</Button>}
              <Button variant="destructive" onClick={() => { ask?.run(); setAsk(null); }}>{ask?.yes}</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={!!rename} onOpenChange={(o) => !o && setRename(null)}>
          <DialogContent className="sm:max-w-md">
            <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); const v = rename!.value.trim(); if (v) { rename!.run(v); setRename(null); } }}>
              <DialogHeader><DialogTitle>{rename?.title}</DialogTitle><DialogDescription className="sr-only">Type a name</DialogDescription></DialogHeader>
              <Input autoFocus aria-label="Name" maxLength={60} placeholder="Name" value={rename?.value ?? ''} onChange={(e) => setRename((r) => r && { ...r, value: e.target.value })} />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setRename(null)}>Cancel</Button>
                <Button type="submit" disabled={!rename?.value.trim()}>Save</Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <MoodDialog voice={voices.find((v) => v.id === moodFor) ?? null} onClose={() => setMoodFor(null)} onChanged={loadVoices} />
        <Toaster theme={dark ? 'dark' : 'light'} position="top-center" richColors />
      </div>
    </IconContext.Provider>
  );
}

const NONE: Take[] = [];
const NONE_E: Status['engines'] = [];
