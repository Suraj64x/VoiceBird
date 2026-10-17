import { useEffect, useRef, useState } from 'react';
import { CircleNotch, Microphone, Play, Stop, UploadSimple } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { api, type Voice } from '@/api';

const BARS = 320;

export function VoiceDialog({ open, onOpenChange, onSaved, mood }: {
  open: boolean; onOpenChange: (o: boolean) => void; onSaved: (v: Voice) => void;
  mood?: { voice: Voice; mood: string } | null; // set: record a mood sample for this voice instead of a new voice
}) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState('');
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [clean, setClean] = useState(true);
  const [consent, setConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (open) return;
    rec.current?.state === 'recording' && rec.current.stop();
    audio.current?.pause();
    setBlob(null); setFileName(''); setPeaks(null); setDuration(0); setStart(0); setEnd(0);
    setName(''); setText(''); setClean(true); setConsent(false); setRecording(false); setBusy(false);
  }, [open]);

  async function load(b: Blob, label: string) {
    setBlob(b); setFileName(label); setPeaks(null);
    if (!name) setName(label.replace(/\.[^.]+$/, '').slice(0, 60));
    try {
      const ctx = new AudioContext();
      const buf = await ctx.decodeAudioData(await b.arrayBuffer());
      ctx.close();
      const data = buf.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / BARS));
      const p: number[] = [];
      for (let i = 0; i < BARS; i++) {
        let m = 0;
        for (let k = i * step; k < Math.min(data.length, (i + 1) * step); k++) m = Math.max(m, Math.abs(data[k]));
        p.push(m);
      }
      setPeaks(p); setDuration(buf.duration); setStart(0); setEnd(Math.min(buf.duration, 300));
    } catch {
      setDuration(0); setStart(0); setEnd(0);
      toast.info("Can't draw this file, but it will still work.");
    }
  }

  // draw the wave + the selected part
  useEffect(() => {
    const c = canvas.current;
    if (!c || !peaks) return;
    const g = c.getContext('2d')!;
    const css = getComputedStyle(document.documentElement);
    const w = c.width, h = c.height, top = Math.max(...peaks, 0.01);
    g.clearRect(0, 0, w, h);
    const x0 = (start / duration) * w, x1 = (end / duration) * w;
    g.globalAlpha = 0.16;
    g.fillStyle = css.getPropertyValue('--violet');
    g.fillRect(x0, 0, x1 - x0, h);
    g.globalAlpha = 1;
    peaks.forEach((p, i) => {
      const x = (i / BARS) * w, bh = Math.max(2, (p / top) * (h - 12));
      g.fillStyle = css.getPropertyValue(x >= x0 && x <= x1 ? '--violet' : '--input');
      g.fillRect(x, (h - bh) / 2, Math.max(1, w / BARS - 1), bh);
    });
    g.fillStyle = css.getPropertyValue('--violet');
    g.fillRect(x0 - 1, 0, 2, h);
    g.fillRect(x1 - 1, 0, 2, h);
  }, [peaks, start, end, duration]);

  // drag on the wave: grab the nearer edge
  const drag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!duration || !(e.buttons & 1)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const t = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * duration * 10) / 10;
    if (Math.abs(t - start) < Math.abs(t - end)) setStart(Math.min(t, end - 1));
    else setEnd(Math.max(t, start + 1));
  };

  async function toggleRecord() {
    if (recording) return rec.current?.stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => chunks.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        load(new Blob(chunks, { type: r.mimeType }), 'Recording.webm');
      };
      r.start();
      rec.current = r;
      setRecording(true);
    } catch {
      toast.error('No microphone found, or permission was not given.');
    }
  }

  function playSelection() {
    if (!blob) return;
    audio.current?.pause();
    const a = new Audio(URL.createObjectURL(blob));
    audio.current = a;
    a.currentTime = start;
    a.ontimeupdate = () => end > start && a.currentTime >= end && a.pause();
    a.play();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!blob) return toast.error('Add a sample first: upload a file or record one.');
    if (!consent) return toast.error('Please confirm you own this voice or have permission to use it.');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', blob, fileName || 'sample');
      fd.append('name', name.trim());
      fd.append('start', String(start));
      fd.append('end', String(end));
      fd.append('clean', String(clean));
      fd.append('transcript', text.trim());
      fd.append('consent', 'true');
      const v = await api.form<Voice>(mood ? `/voices/${mood.voice.id}/moods/${mood.mood}` : '/voices', fd);
      toast.success(mood ? `${mood.mood[0].toUpperCase() + mood.mood.slice(1)} sample saved` : `Voice "${v.name}" saved`);
      onSaved(v);
      onOpenChange(false);
    } catch (err: any) {
      toast.error(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="hue-violet sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-extrabold tracking-tight">{mood ? <span className="capitalize">{mood.mood} · {mood.voice.name}</span> : 'New voice'}</DialogTitle>
          <DialogDescription>{mood ? `The same voice, speaking ${mood.mood}. 10 to 30 seconds works best.` : '10 seconds to 5 minutes of clear speech. No music.'}</DialogDescription>
        </DialogHeader>
        <form onSubmit={save} className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" asChild>
              <label>
                <UploadSimple /> Upload
                <input type="file" accept="audio/*,video/*" hidden onChange={(e) => e.target.files?.[0] && load(e.target.files[0], e.target.files[0].name)} />
              </label>
            </Button>
            <Button type="button" variant={recording ? 'destructive' : 'outline'} onClick={toggleRecord}>
              {recording ? <><Stop weight="fill" /> Stop</> : <><Microphone /> Record</>}
            </Button>
            <span className="min-w-0 truncate text-sm text-muted-foreground">{recording ? 'Recording…' : fileName}</span>
          </div>

          {peaks && (
            <div className="grid gap-2">
              <canvas ref={canvas} width={1040} height={160} onPointerDown={drag} onPointerMove={drag}
                className="h-20 w-full cursor-col-resize touch-none rounded-lg border bg-muted/40" aria-label="Sample waveform. Drag to trim." />
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-1.5">Start
                  <Input type="number" className="h-8 w-20" min={0} max={duration} step="any" value={start} onChange={(e) => setStart(Math.max(0, Math.min(+e.target.value, end - 1)))} /> s
                </label>
                <label className="flex items-center gap-1.5">End
                  <Input type="number" className="h-8 w-20" min={0} max={duration} step="any" value={end} onChange={(e) => setEnd(Math.min(duration, Math.max(+e.target.value, start + 1)))} /> s
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={playSelection}><Play weight="fill" /> Play</Button>
                <span className="font-mono text-xs text-muted-foreground">{(end - start).toFixed(1)} s selected{end - start > 30 ? ' · best 18 s used' : ''}</span>
              </div>
            </div>
          )}

          <div className={cn('grid gap-1.5', mood && 'hidden')}>
            <Label htmlFor="vName">Name</Label>
            <Input id="vName" required={!mood} maxLength={60} placeholder="e.g. Jason" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vText">Transcript</Label>
            <Textarea id="vText" rows={2} placeholder="Leave blank to detect it automatically" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={clean} onCheckedChange={(c) => setClean(c === true)} /> Auto-clean
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={consent} onCheckedChange={(c) => setConsent(c === true)} /> I own this voice or have permission to use it
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !blob || !consent || (!mood && !name.trim())}>
              {busy && <CircleNotch className="animate-spin" />}{busy ? 'Saving…' : mood ? 'Save sample' : 'Save voice'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
