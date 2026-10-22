import { useState } from 'react';
import { Plus, Trash } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api, clock, MOODS, moodUrl, type Voice } from '@/api';
import { cn } from '@/lib/utils';
import { Player } from './Player';
import { VoiceDialog } from './VoiceDialog';

/** Per-voice clips of the same person in each mood. Picking that emotion then uses the clip as the reference. */
export function MoodDialog({ voice, onClose, onChanged }: { voice: Voice | null; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const [adding, setAdding] = useState<string | null>(null);
  const moods = voice?.moods ?? {};
  const count = Object.keys(moods).length;

  const remove = async (mood: string) => {
    if (!voice) return;
    try { await api.del(`/voices/${voice.id}/moods/${mood}`); await onChanged(); } catch (e: any) { toast.error(e.message); }
  };

  return (
    <>
      <Dialog open={!!voice && !adding} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="hue-violet sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-xl font-extrabold tracking-tight">Mood samples · {voice?.name}</DialogTitle>
            <DialogDescription>Record the same voice in a mood. That emotion then speaks like the clip. {count ? `${count} added.` : ''}</DialogDescription>
          </DialogHeader>
          <ul className="grid gap-1">
            {MOODS.map(([id, hue]) => {
              const m = moods[id];
              return (
                <li key={id} className={cn(`hue-${hue}`, 'flex h-11 items-center gap-2.5 rounded-md border px-2.5', m ? 'border-hue/50 bg-hue-soft' : '')}>
                  <span className="size-2.5 shrink-0 rounded-[3px] bg-hue" />
                  <span className="w-20 text-[14px] font-semibold capitalize">{id}</span>
                  {m && voice ? (
                    <>
                      <Player compact src={moodUrl(voice, id)} label={`${id} sample`} title={`${voice.name} · ${id}`} sub="Mood sample" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={m.transcript}>{clock(m.duration)}</span>
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setAdding(id)}>Replace</Button>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={`Remove ${id} sample`} onClick={() => remove(id)}><Trash weight="bold" /></Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1" />
                      <Button variant="outline" size="sm" className="h-8" onClick={() => setAdding(id)}><Plus weight="bold" /> Add</Button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
      <VoiceDialog open={!!adding} mood={voice && adding ? { voice, mood: adding } : null}
        onOpenChange={(o) => !o && setAdding(null)} onSaved={() => { onChanged(); }} />
    </>
  );
}
