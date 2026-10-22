import { useEffect, useState } from 'react';
import { ArrowsClockwise, ClockCounterClockwise, Star } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ago, api, clock, takeUrl, type HistoryItem } from '@/api';
import { Section } from './bits';
import { Player } from './Player';

/** Everything you generated lately, across all projects: listen again or jump back to the project. */
export function History({ onOpen, refresh }: { onOpen: (project: string) => void; refresh: unknown }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const load = () => api.get<HistoryItem[]>('/history?limit=60').then(setItems).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Section icon={ClockCounterClockwise} title="History" hue="blue" className="border-b-0"
      action={<Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Refresh history" title="Refresh" onClick={load}><ArrowsClockwise weight="bold" /></Button>}>
      {items && !items.length && <p className="py-6 text-center text-sm text-muted-foreground">Nothing generated yet.</p>}
      <ol className="-mx-1.5 grid gap-0.5">
        {items?.map((t) => (
          <li key={t.id} className="grid gap-1.5 rounded-md p-1.5 hover:bg-muted">
            <div className="flex items-center gap-2">
              <button className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold leading-tight hover:underline" onClick={() => onOpen(t.project)} title="Open project">
                {t.projectName || 'Untitled script'}
              </button>
              {t.picked && <Star weight="fill" className="size-3 shrink-0 text-[var(--amber)]" aria-label="picked take" />}
              <span className="shrink-0 text-xs text-muted-foreground">{ago(t.created)}</span>
            </div>
            <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{t.text}</p>
            <div className="flex items-center gap-2">
              <Player compact preload="none" src={takeUrl(t.project, t.id)} label={`take from ${t.projectName}`} title={t.projectName || 'Untitled script'} sub={t.text} />
              <span className="min-w-0 truncate text-xs text-muted-foreground">{t.engine.replace(/\s*\(.*\)$/, '')} · {t.voiceName} · <span className="font-mono">{clock(t.duration)}</span></span>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}
