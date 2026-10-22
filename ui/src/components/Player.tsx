import { useEffect, useState } from 'react';
import { FastForward, Pause, Play, Rewind, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { clock } from '@/api';
import { audio, useAudio } from '@/lib/audio';
import { cn } from '@/lib/utils';

/** Length of a clip without playing it (only when we don't already know it). */
function useLength(src: string, known: number | undefined, preload: 'none' | 'metadata') {
  const [d, setD] = useState(known ?? 0);
  useEffect(() => {
    if (known || preload === 'none') return;
    const a = new Audio();
    const f = () => setD(a.duration);
    a.preload = 'metadata';
    a.addEventListener('loadedmetadata', f);
    a.src = src;
    return () => { a.removeEventListener('loadedmetadata', f); a.removeAttribute('src'); a.load(); };
  }, [src, known, preload]);
  return known || d;
}

/** Play button + scrubber, driving the app's one shared player. With `peaks` the scrubber is the clip's real waveform. */
export function Player({ src, peaks, compact, label = 'clip', title, sub, duration, preload = 'metadata', className }: {
  src: string; peaks?: number[]; compact?: boolean; label?: string; title?: string; sub?: string; duration?: number;
  preload?: 'none' | 'metadata'; className?: string;
}) {
  const s = useAudio();
  const mine = s.track?.src === src;
  const playing = mine && s.playing;
  const t = mine ? s.time : 0;
  const len = useLength(src, duration, compact ? 'none' : preload);
  const d = mine && s.duration ? s.duration : len;
  const track = { src, title: title ?? label, sub };
  const toggle = () => audio.toggle(track);
  const seek = (to: number) => (mine ? audio.seek(to) : audio.play(track, to));

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      <Button type="button" size="icon" variant={compact ? 'ghost' : 'outline'} className="size-8 shrink-0" onClick={toggle} aria-label={`${playing ? 'Pause' : 'Play'} ${label}`} title={`${playing ? 'Pause' : 'Play'} ${label}`}>
        {playing ? <Pause weight="fill" /> : <Play weight="fill" />}
      </Button>
      {!compact && (
        <>
          {peaks?.length ? (
            <div role="slider" tabIndex={0} aria-label={`Seek ${label}`} aria-valuemin={0} aria-valuemax={Math.round(d)} aria-valuenow={Math.round(t)}
              className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-px rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * d); }}
              onKeyDown={(e) => { if (e.key === 'ArrowRight') seek(t + 2); else if (e.key === 'ArrowLeft') seek(t - 2); else if (e.key === ' ') { e.preventDefault(); toggle(); } }}>
              {peaks.map((p, i) => (
                <span key={i} className={cn('min-w-px flex-1 rounded-[1px]', mine && d && i / peaks.length < t / d ? 'bg-success' : 'bg-input')} style={{ height: `${Math.max(8, p * 100)}%` }} />
              ))}
            </div>
          ) : (
            <input type="range" className="seek min-w-0 flex-1" aria-label={`Seek ${label}`} min={0} max={d || 0} step={0.01} value={t} onChange={(e) => seek(+e.target.value)} />
          )}
          <span className="w-[76px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">{clock(t)} / {clock(d)}</span>
        </>
      )}
    </div>
  );
}

const RATES = [1, 1.25, 1.5, 2, 0.75];

/** The bar in the top strip: whatever is playing, wherever you are in the app. Space plays/pauses. */
export function NowPlaying() {
  const s = useAudio();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || !audio.state.track) return;
      if ((e.target as HTMLElement).closest('input, textarea, select, button, a, [role=slider], [role=radio], [role=tab], [contenteditable]')) return;
      e.preventDefault();
      audio.toggle();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);
  if (!s.track) return null;
  const d = s.duration || 0;
  const next = RATES[(RATES.indexOf(s.rate) + 1) % RATES.length];
  return (
    <div role="region" aria-label="Now playing" className="flex h-9 min-w-0 max-w-[620px] flex-1 items-center gap-1 rounded-md border bg-background pl-1 pr-1.5">
      <Button variant="ghost" size="icon" className="hidden size-7 text-muted-foreground sm:grid" aria-label="Back 5 seconds" title="Back 5 s" onClick={() => audio.seek(s.time - 5)}><Rewind weight="fill" /></Button>
      <Button size="icon" className="size-7 shrink-0" aria-label={s.playing ? 'Pause' : 'Play'} title={s.playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => audio.toggle()}>
        {s.playing ? <Pause weight="fill" /> : <Play weight="fill" />}
      </Button>
      <Button variant="ghost" size="icon" className="hidden size-7 text-muted-foreground sm:grid" aria-label="Forward 5 seconds" title="Forward 5 s" onClick={() => audio.seek(s.time + 5)}><FastForward weight="fill" /></Button>
      <span className="ml-1 min-w-0 max-w-44 shrink">
        <span className="block truncate text-[13px] font-semibold leading-tight">{s.track.title}</span>
        {s.track.sub && <span className="block truncate text-[11px] leading-tight text-muted-foreground">{s.track.sub}</span>}
      </span>
      <input type="range" className="seek mx-1.5 hidden min-w-12 flex-1 md:block" aria-label="Seek" min={0} max={d} step={0.01} value={s.time} onChange={(e) => audio.seek(+e.target.value)} />
      <span className="hidden shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground md:inline">{clock(s.time)} / {clock(d)}</span>
      <button type="button" className="ml-1 h-6 shrink-0 rounded-[4px] border px-1.5 font-mono text-[11px] font-semibold tabular-nums text-muted-foreground hover:text-foreground" aria-label={`Playback speed ${s.rate}×, change to ${next}×`} title="Playback speed" onClick={() => audio.rate(next)}>{s.rate}×</button>
      <Button variant="ghost" size="icon" className="size-7 shrink-0 text-muted-foreground" aria-label="Close player" title="Close" onClick={() => audio.close()}><X weight="bold" /></Button>
    </div>
  );
}
