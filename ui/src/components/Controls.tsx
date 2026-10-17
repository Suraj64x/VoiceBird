import { memo } from 'react';
import { ArrowCounterClockwise, Fingerprint, MaskHappy, Metronome, Microphone, MicrophoneStage, Shuffle, SpeakerHigh } from '@phosphor-icons/react';
import { Slider as S } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { DEFAULTS, MOODS, type Engine, type Settings, type Voice } from '@/api';
import { cn } from '@/lib/utils';
import { Section, type Hue } from './bits';
import { Styles } from './Styles';


/** A fill bar: drag or click anywhere on it, arrow keys when focused. Label left, value right, inside the bar. */
function Range({ id, label, value, show, min, max, step, onChange }: {
  id: string; label: string; value: number; show: string; min: number; max: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <S.Root id={id} aria-label={label} value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v)}
      className="group relative flex h-9 w-full cursor-ew-resize touch-none select-none items-center overflow-hidden rounded-md border bg-muted/50 transition-colors hover:border-input">
      <S.Track className="absolute inset-0">
        <S.Range className="absolute inset-y-0 bg-hue-soft" />
      </S.Track>
      <S.Thumb className="block h-4 w-[3px] rounded-full bg-hue outline-none transition-[height,box-shadow] group-hover:h-5 focus-visible:h-5 focus-visible:shadow-[0_0_0_3px_color-mix(in_oklab,var(--hue)_35%,transparent)]" />
      <span className="pointer-events-none absolute left-3 text-[13px] font-medium">{label}</span>
      <output className="pointer-events-none absolute right-3 font-mono text-[13px] font-semibold tabular-nums">{show}</output>
    </S.Root>
  );
}

/** five little bars, filled up to value (1-5) */
function Meter({ label, value, hue }: { label: string; value: number; hue: Hue }) {
  return (
    <span className={cn(`hue-${hue}`, 'flex items-center gap-1.5 text-[11px] text-muted-foreground')} aria-label={`${label} ${value} of 5`}>
      <span className="w-9">{label}</span>
      <span className="flex gap-0.5">{[1, 2, 3, 4, 5].map((i) => <i key={i} className={cn('h-1.5 w-2.5 rounded-[1px]', i <= value ? 'bg-hue' : 'bg-input')} />)}</span>
    </span>
  );
}

// tone = how the finished voice sounds; applied on playback and export, so it switches instantly
const TONES: [string, string, Hue][] = [
  ['natural', 'Natural', 'slate'], ['soft', 'Soft', 'pink'], ['warm', 'Warm', 'amber'],
  ['bright', 'Bright', 'cyan'], ['broadcast', 'Broadcast', 'red'], ['deep', 'Deep', 'violet'],
];

const short = (name: string) => name.replace(/\s*\(.*\)$/, '');

export const Controls = memo(function Controls({ s, set, voices, engines, defaultEngine, onMoods }: {
  s: Settings; set: (patch: Partial<Settings>) => void; voices: Voice[]; engines: Engine[]; defaultEngine: string; onMoods: (v: Voice) => void;
}) {
  const voiceId = s.voice && voices.some((v) => v.id === s.voice) ? s.voice : voices.find((v) => v.default)?.id ?? '';
  const engineId = s.engine && engines.some((e) => e.id === s.engine) ? s.engine : defaultEngine;
  const engine = engines.find((e) => e.id === engineId);
  const voice = voices.find((v) => v.id === voiceId);

  return (
    <>
      <Section icon={Microphone} title="Voice" hue="violet" info={<>
        {engines.map((e) => (
          <p key={e.id}><b>{short(e.name)}</b> — {e.note} <span className="text-muted-foreground">{e.licence}, {e.commercial ? 'OK to monetize' : 'not for monetized videos'}.</span></p>
        ))}</>}>
        <div className="grid grid-cols-1 gap-2.5">
          <Select value={voiceId} onValueChange={(v) => set({ voice: v })}>
            <SelectTrigger aria-label="Voice" className="h-10 w-full min-w-0 text-[15px] font-semibold"><SelectValue placeholder="No voice yet" /></SelectTrigger>
            <SelectContent>{voices.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
          </Select>
          <div role="radiogroup" aria-label="Engine" className="grid gap-1.5">
            {engines.map((e) => {
              const on = e.id === engineId;
              return (
                <button key={e.id} type="button" role="radio" aria-checked={on} aria-label={e.name} onClick={() => set({ engine: e.id })}
                  className={cn('grid gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors', on ? 'border-hue bg-hue-soft' : 'hover:bg-muted')}>
                  <span className="flex items-center gap-1.5">
                    <span className="text-[14px] font-bold leading-tight">{short(e.name)}</span>
                    {e.id === defaultEngine && <span className="ml-auto rounded-[3px] bg-accent px-1.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-muted-foreground">Default</span>}
                  </span>
                  <span className="grid grid-cols-2 gap-3">
                    <Meter label="Match" value={e.match} hue="violet" />
                    <Meter label="Speed" value={e.speed} hue="cyan" />
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Styles s={s} set={set} />

      <Section icon={MaskHappy} title="Delivery" hue="amber"
        action={voice && <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[12px] text-muted-foreground" title="Record this voice in different moods" onClick={() => onMoods(voice)}><MicrophoneStage weight="bold" /> Mood samples</Button>}
        info={<>
        <p>Moods marked with a small mic use your own <b>mood sample</b> of this voice. That is what really changes the delivery, on every engine.</p>
        <p>Pick the mood, then how strong it is. The style box understands words like <i>hyped, calm, fast, deep</i>.</p>
        <p>{engine?.emotion ? `${short(engine.name)} really changes how animated the voice is.` : `${engine ? short(engine.name) : 'This engine'} keeps the tone of the sample; emotion only nudges pace and pitch. Chatterbox has a real emotion control.`}</p></>}>
        <div className="grid grid-cols-1 gap-3">
          <div role="radiogroup" aria-label="Emotion" className="grid grid-cols-3 gap-1.5">
            {MOODS.map(([id, hue]) => {
              const on = s.emotion === id;
              const own = !!voice?.moods?.[id];
              return (
                <button key={id} type="button" role="radio" aria-checked={on} onClick={() => set({ emotion: id })}
                  title={own ? 'Uses your mood sample' : undefined}
                  className={cn(`hue-${hue}`, 'flex h-9 min-w-0 items-center gap-1.5 rounded-md border px-2 text-[13px] font-medium capitalize transition-colors',
                    on ? 'border-hue bg-hue-soft text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                  <span className={cn('size-2 shrink-0 rounded-[2px] bg-hue', !on && 'opacity-70')} /><span className="truncate">{id}</span>
                  {own && <MicrophoneStage weight="fill" className="ml-auto size-3 shrink-0 text-hue" aria-label="mood sample" />}
                </button>
              );
            })}
          </div>
          <Range id="intensity" label="Intensity" value={s.intensity} show={`${s.intensity}%`} min={0} max={100} step={5} onChange={(v) => set({ intensity: v })} />
          <Textarea aria-label="Style prompt" rows={2} className="min-h-0 resize-none" placeholder="Style, e.g. hyped YouTube host" value={s.style} onChange={(e) => set({ style: e.target.value })} />
        </div>
      </Section>

      <Section icon={SpeakerHigh} title="Tone" hue="violet" info={<>
        <p>How the finished voice sounds. It changes every take instantly, for playing and exporting, with no regenerating.</p>
        <p><b>Soft</b> rounds off sharp s-sounds and highs. <b>Warm</b> adds body. <b>Bright</b> adds clarity. <b>Broadcast</b> is punchy and even, like radio. <b>Deep</b> adds weight.</p></>}>
        <div role="radiogroup" aria-label="Tone" className="grid grid-cols-3 gap-1.5">
          {TONES.map(([id, name, hue]) => {
            const on = (s.tone || 'natural') === id;
            return (
              <button key={id} type="button" role="radio" aria-checked={on} onClick={() => set({ tone: id })}
                className={cn(`hue-${hue}`, 'flex h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-[13px] font-semibold transition-colors',
                  on ? 'border-hue bg-hue-soft text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
                <span className={cn('size-2 shrink-0 rounded-[2px] bg-hue', !on && 'opacity-70')} />{name}
              </button>
            );
          })}
        </div>
      </Section>

      <Section icon={Metronome} title="Pace and pitch" hue="cyan" info={<>
        <p><b>Pace 1.00×</b> means as fast as the voice sample talks. Every take is matched to it first.</p>
        <p><b>Pitch</b> moves the voice up or down in semitones; small steps sound most natural.</p>
        <p><b>Pause</b> is the silence at each blank line in your script.</p></>}>
        <div className="grid grid-cols-1 gap-2">
          <Range id="speed" label="Pace" value={s.speed} show={`${s.speed.toFixed(2)}×`} min={0.7} max={1.3} step={0.01} onChange={(v) => set({ speed: v })} />
          <Range id="pitch" label="Pitch" value={s.pitch} show={`${s.pitch > 0 ? '+' : ''}${s.pitch} st`} min={-6} max={6} step={0.5} onChange={(v) => set({ pitch: v })} />
          <Range id="pause" label="Pause" value={s.pause} show={`${s.pause.toFixed(2)} s`} min={0} max={2} step={0.05} onChange={(v) => set({ pause: v })} />
        </div>
      </Section>

      <Section icon={Fingerprint} title="Consistency" hue="pink" className="border-b-0" info={<>
        <p><b>Expressiveness</b>: low gives steady, even reads; high gives livelier, more varied ones.</p>
        <p><b>Seed</b>: the same seed and settings give the same audio. With the lock on, New take still gives a fresh read.</p></>}
        action={<Button type="button" variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Reset controls" title="Reset controls" onClick={() => set({ ...DEFAULTS, voice: s.voice, engine: s.engine })}><ArrowCounterClockwise weight="bold" /></Button>}>
        <div className="grid grid-cols-1 gap-2">
          <Range id="variation" label="Expressiveness" value={s.variation} show={`${s.variation}%`} min={0} max={100} step={5} onChange={(v) => set({ variation: v })} />
          <div className="flex items-center gap-1.5">
            <label htmlFor="seed" className="flex h-9 shrink-0 items-center rounded-md border bg-muted/50 px-3 text-[13px] font-medium">Seed</label>
            <Input id="seed" type="number" min={0} step={1} className="h-9 min-w-0 font-mono text-[13px] tabular-nums" value={s.seed} onChange={(e) => set({ seed: Math.max(0, Math.floor(+e.target.value || 0)) })} />
            <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" aria-label="New random seed" title="New random seed" onClick={() => set({ seed: Math.floor(Math.random() * 1e6) })}><Shuffle weight="bold" /></Button>
          </div>
          <label className="flex h-9 items-center justify-between gap-2 rounded-md border bg-muted/50 px-3 text-[13px] font-medium">
            Lock seed
            <Switch checked={s.lockSeed} onCheckedChange={(c) => set({ lockSeed: c })} />
          </label>
        </div>
      </Section>
    </>
  );
});
