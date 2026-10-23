import { useState } from 'react';
import { MagnifyingGlassPlus } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

const SIZES = [0.9, 1, 1.1, 1.25, 1.5];

/** Make the whole interface bigger or smaller (remembered). The zoom itself is CSS: see --ui-zoom in index.css. */
export function UiScale() {
  const [z, setZ] = useState(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1);
  const pick = (v: string) => {
    const n = +v;
    document.documentElement.style.setProperty('--ui-zoom', String(n));
    try { localStorage.uiZoom = String(n); } catch { /* private mode */ }
    setZ(n);
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-8 gap-1 px-2 font-mono text-xs tabular-nums text-muted-foreground" aria-label={`Interface size ${Math.round(z * 100)}%`} title="Interface size">
          <MagnifyingGlassPlus weight="bold" className="size-4" />{Math.round(z * 100)}%
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-40">
        <DropdownMenuLabel>Interface size</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(z)} onValueChange={pick}>
          {SIZES.map((s) => <DropdownMenuRadioItem key={s} value={String(s)} className="font-mono tabular-nums">{Math.round(s * 100)}%{s === 1 ? '  default' : ''}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
