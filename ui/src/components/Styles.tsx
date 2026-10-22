import { useEffect, useRef, useState } from 'react';
import { BookmarksSimple, Check, Plus, X } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { api, type Preset, type Settings } from '@/api';
import { cn } from '@/lib/utils';
import { Section } from './bits';

type Look = Omit<Preset, 'name'>;
const FIELDS = ['emotion', 'intensity', 'style', 'speed', 'pitch', 'pause', 'variation', 'tone'] as const;

// starters everyone gets; saved styles come after them
const BUILT_IN: Preset[] = [
  { name: 'YouTube hype', emotion: 'excited', intensity: 60, style: 'hyped YouTube host, smiling', speed: 1.05, pitch: 0, pause: 0.5, variation: 60, tone: 'bright' },
  { name: 'Explainer', emotion: 'friendly', intensity: 50, style: 'clear, warm explainer', speed: 1, pitch: 0, pause: 0.6, variation: 45, tone: 'natural' },
  { name: 'Soft & gentle', emotion: 'calm', intensity: 40, style: 'soft, gentle, close to the mic', speed: 0.95, pitch: 0, pause: 0.7, variation: 35, tone: 'soft' },
  { name: 'Calm story', emotion: 'calm', intensity: 50, style: 'calm storyteller', speed: 0.92, pitch: -1, pause: 0.8, variation: 40, tone: 'warm' },
  { name: 'Podcast', emotion: 'friendly', intensity: 50, style: 'relaxed podcast host', speed: 1, pitch: 0, pause: 0.6, variation: 50, tone: 'broadcast' },
  { name: 'Serious', emotion: 'serious', intensity: 50, style: 'serious documentary narrator', speed: 0.97, pitch: 0, pause: 0.7, variation: 35, tone: 'deep' },
];

const look = (s: Settings | Preset): Look => Object.fromEntries(FIELDS.map((k) => [k, s[k]])) as Look;
const same = (a: Look, b: Look) => FIELDS.every((k) => a[k] === b[k]);

/** One-click delivery styles: four starters plus your own, saved for every project. */
export function Styles({ s, set }: { s: Settings; set: (patch: Partial<Settings>) => void }) {
  const [saved, setSaved] = useState<Preset[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { api.get<Preset[]>('/presets').then(setSaved).catch(() => {}); }, []);
  useEffect(() => { if (naming !== null) input.current?.focus(); }, [naming]);

  const store = (next: Preset[]) => { setSaved(next); api.put<Preset[]>('/presets', next).catch((e) => toast.error(e.message)); };
  const save = () => {
    const name = naming?.trim();
    if (!name) return setNaming(null);
    store([...saved.filter((p) => p.name !== name), { name, ...look(s) }]);
    setNaming(null);
    toast.success(`Saved "${name}"`);
  };
  const cur = look(s);

  const chip = (p: Preset, mine: boolean) => {
    const on = same(look(p), cur);
    return (
      <span key={(mine ? 'm:' : 'b:') + p.name} className={cn('group inline-flex h-8 items-center rounded-md border text-[13px] font-semibold transition-colors',
        on ? 'border-hue bg-hue-soft text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground')}>
        <button type="button" aria-pressed={on} className="flex h-full items-center gap-1.5 pl-2.5 pr-2.5 group-has-[[data-x]]:pr-1" onClick={() => set(look(p))}
          title={`${p.emotion} · ${p.tone ?? 'natural'} tone · ${p.speed.toFixed(2)}× · ${p.pitch > 0 ? '+' : ''}${p.pitch} st${p.style ? ` · "${p.style}"` : ''}`}>
          {on && <Check weight="bold" className="size-3.5 text-hue" />}{p.name}
        </button>
        {mine && (
          <button type="button" data-x aria-label={`Delete style ${p.name}`} className="mr-1 grid size-5 place-items-center rounded-[3px] opacity-60 hover:bg-accent hover:opacity-100"
            onClick={() => store(saved.filter((x) => x.name !== p.name))}><X weight="bold" className="size-3" /></button>
        )}
      </span>
    );
  };

  return (
    <Section icon={BookmarksSimple} title="Styles" hue="green" info={<p>One click sets mood, tone, intensity, style words, pace, pitch, pause and expressiveness. <b>Save current</b> keeps your own for every project; hover a chip to see what it sets.</p>}>
      <div className="flex flex-wrap gap-1.5">
        {BUILT_IN.map((p) => chip(p, false))}
        {saved.map((p) => chip(p, true))}
        {naming === null ? (
          <button type="button" onClick={() => setNaming('')} className="inline-flex h-8 items-center gap-1 rounded-md border border-dashed px-2.5 text-[13px] font-semibold text-muted-foreground hover:border-hue hover:text-foreground">
            <Plus weight="bold" className="size-3.5" /> Save current
          </button>
        ) : (
          <form className="flex w-full gap-1.5" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Input ref={input} aria-label="Style name" placeholder="Name this style" maxLength={40} value={naming} onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} className="h-8 min-w-0 text-[13px]" />
            <button type="submit" className="h-8 shrink-0 rounded-md bg-primary px-3 text-[13px] font-bold text-primary-foreground">Save</button>
          </form>
        )}
      </div>
    </Section>
  );
}
