import { ArrowSquareOut, Bug, Copy, DiscordLogo, TelegramLogo } from '@phosphor-icons/react';
import { Popover } from 'radix-ui';
import { toast } from 'sonner';
import { api, type Status } from '@/api';

const TELEGRAM = 'smokiex0';
const DISCORD = 'smokiex08';

const copy = (text: string, what: string) =>
  navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error('Could not copy'));

/** What a bug report needs, ready to paste: engines, graphics card or not, browser. */
async function details() {
  const s = await api.get<Status & { job: { message?: string } | null }>('/status').catch(() => null);
  return [
    `VoiceBird · ${new Date().toISOString()}`,
    `Device: ${s?.device ?? 'unknown'} · default engine: ${s?.defaultEngine ?? '-'}`,
    `Engines: ${s?.engines.map((e) => e.id).join(', ') ?? '-'}`,
    `Job: ${s?.job?.message ?? 'none'}`,
    `Browser: ${navigator.userAgent} · ${innerWidth}×${innerHeight}`,
  ].join('\n');
}

const row = 'flex h-11 items-center gap-2.5 rounded-md border px-2.5 text-left transition-colors hover:bg-muted';

export function BugReport() {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className="flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground">
          <Bug weight="bold" className="size-4 text-[var(--red)]" /> Report a bug
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={12}
          className="z-50 grid w-72 gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <p className="font-display text-[16px] font-extrabold tracking-tight">Report a bug</p>
          <p className="-mt-1 text-[13px] text-muted-foreground">What you did, what went wrong. A screenshot helps.</p>
          <a href={`https://t.me/${TELEGRAM}`} target="_blank" rel="noreferrer" className={row}>
            <TelegramLogo weight="fill" className="size-5 shrink-0 text-[#2AABEE]" />
            <span className="grow"><span className="block text-[13px] font-semibold leading-tight">Telegram</span><span className="block text-xs text-muted-foreground">@{TELEGRAM}</span></span>
            <ArrowSquareOut weight="bold" className="size-4 text-muted-foreground" />
          </a>
          <button type="button" className={row} onClick={() => copy(DISCORD, 'Discord name')}>
            <DiscordLogo weight="fill" className="size-5 shrink-0 text-[#5865F2]" />
            <span className="grow"><span className="block text-[13px] font-semibold leading-tight">Discord</span><span className="block text-xs text-muted-foreground">{DISCORD}</span></span>
            <Copy weight="bold" className="size-4 text-muted-foreground" />
          </button>
          <button type="button" className="mt-1 flex items-center justify-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={async () => copy(await details(), 'App details')}>
            <Copy weight="bold" className="size-3.5" /> Copy app details for your message
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
