import type { ReactNode } from 'react';
import { ArrowRight, Article, Check, Info as InfoIcon, MicrophoneStage, Waveform, type Icon } from '@phosphor-icons/react';
import { Popover } from 'radix-ui';
import { cn } from '@/lib/utils';

export type Hue = 'green' | 'cyan' | 'blue' | 'violet' | 'pink' | 'amber' | 'red' | 'slate';
export const HUES: Hue[] = ['violet', 'cyan', 'amber', 'pink', 'blue', 'green'];

/** A small coloured square holding a two-tone icon. The colour comes from the nearest hue-* class. */
export function Tile({ icon: I, hue, big, className }: { icon: Icon; hue?: Hue; big?: boolean; className?: string }) {
  return (
    <span className={cn('grid shrink-0 place-items-center rounded-md bg-hue-soft text-hue', big ? 'size-16 border border-hue/30' : 'size-7', hue && `hue-${hue}`, className)}>
      <I weight="duotone" className={big ? 'size-9' : 'size-[18px]'} />
    </span>
  );
}

/** A picture if there is one, otherwise a coloured square with a letter or an icon. */
export function Avatar({ src, letter, icon: I, hue, size = 36 }: { src?: string; letter?: string; icon?: Icon; hue: Hue; size?: number }) {
  if (src) return <img src={src} alt="" draggable={false} className="shrink-0 rounded-md object-cover" style={{ width: size, height: size }} />;
  return (
    <span className={cn(`hue-${hue}`, 'grid shrink-0 place-items-center rounded-md bg-hue-soft font-display font-extrabold text-hue')} style={{ width: size, height: size, fontSize: size * 0.48 }}>
      {I ? <I weight="bold" style={{ width: size * 0.55, height: size * 0.55 }} /> : letter}
    </span>
  );
}

/** A titled block inside a pane: bold coloured icon + heavy heading. Sets the hue for everything inside. */
export function Section({ icon: I, title, hue = 'green', action, info, children, className }: {
  icon: Icon; title: string; hue?: Hue; action?: ReactNode; info?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={cn('border-b px-4 py-4', `hue-${hue}`, className)}>
      <header className="mb-3 flex h-7 items-center gap-2">
        <I weight="bold" className="size-[18px] shrink-0 text-hue" />
        <h2 className="font-display text-[17px] font-extrabold tracking-tight">{title}</h2>
        {info && <Info label={`About ${title}`}>{info}</Info>}
        <span className="grow" />
        {action}
      </header>
      {children}
    </section>
  );
}

/** A small "i" that opens the explanation, so the panel itself stays clean. */
export function Info({ children, label = 'More info' }: { children: ReactNode; label?: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label={label} className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground data-[state=open]:text-foreground">
          <InfoIcon weight="bold" className="size-[15px]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12}
          className="z-50 grid w-64 gap-2 rounded-md border bg-popover p-3 text-[13px] leading-relaxed text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A square on/off chip, coloured by the area it sits in. */
export function Toggle({ on, onChange, children, className }: { on: boolean; onChange: (on: boolean) => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={() => onChange(!on)}
      className={cn('flex h-10 items-center justify-center gap-1.5 rounded-md border px-3 text-sm font-semibold transition-colors',
        on ? 'border-hue bg-hue-soft text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground', className)}>
      {on && <Check weight="bold" className="size-4 text-hue" />}{children}
    </button>
  );
}

/** Script, voice, sound: shown where takes will appear. */
export function ScriptToSound() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <Tile big icon={Article} hue="blue" className="-rotate-6" />
      <ArrowRight weight="bold" className="size-5 text-muted-foreground" />
      <Tile big icon={MicrophoneStage} hue="violet" />
      <ArrowRight weight="bold" className="size-5 text-muted-foreground" />
      <Tile big icon={Waveform} hue="green" className="rotate-6" />
    </div>
  );
}
