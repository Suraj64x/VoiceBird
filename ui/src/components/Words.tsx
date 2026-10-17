import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Plus, TextAa, Trash } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, type Word } from '@/api';
import { Section } from './bits';

/** "Say it like this": words the voice should pronounce differently (tool names, acronyms). Saved for every project. */
export function Words() {
  const [rows, setRows] = useState<Word[] | null>(null);
  const dirty = useRef(false);

  useEffect(() => { api.get<Word[]>('/words').then((w) => setRows(w.length ? w : [{ said: '', say: '' }])).catch((e) => toast.error(e.message)); }, []);
  useEffect(() => {
    if (!rows || !dirty.current) return;
    const t = setTimeout(() => { dirty.current = false; api.put('/words', rows).catch((e) => toast.error(e.message)); }, 600);
    return () => clearTimeout(t);
  }, [rows]);

  const latest = useRef(rows);
  latest.current = rows;
  useEffect(() => () => { if (dirty.current && latest.current) api.put('/words', latest.current).catch(() => {}); }, []); // save when the tab closes

  const set = (i: number, patch: Partial<Word>) => { dirty.current = true; setRows((r) => r!.map((w, k) => (k === i ? { ...w, ...patch } : w))); };
  const drop = (i: number) => { dirty.current = true; setRows((r) => r!.filter((_, k) => k !== i)); };

  return (
    <Section icon={TextAa} title="Pronunciation" hue="blue" className="border-b-0">
      <div className="grid gap-2">
        {rows?.map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <Input aria-label="Written as" placeholder="FFmpeg" value={w.said} onChange={(e) => set(i, { said: e.target.value })} className="h-9 min-w-0" />
            <ArrowRight weight="bold" className="size-4 shrink-0 text-muted-foreground" />
            <Input aria-label="Say it as" placeholder="F F M peg" value={w.say} onChange={(e) => set(i, { say: e.target.value })} className="h-9 min-w-0" />
            <Button variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground" aria-label="Remove word" onClick={() => drop(i)}><Trash weight="bold" /></Button>
          </div>
        ))}
        <Button variant="outline" className="justify-self-start" onClick={() => { dirty.current = true; setRows((r) => [...(r ?? []), { said: '', say: '' }]); }}><Plus weight="bold" /> Add word</Button>
      </div>
    </Section>
  );
}
