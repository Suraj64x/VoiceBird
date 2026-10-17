import { useEffect, useRef, useState } from 'react';
import { CircleNotch, ImageSquare, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Slider } from '@/components/ui/slider';

export type CropTarget = { title: string; save: (picture: Blob) => Promise<unknown> };

const V = 288;   // crop square on screen (px)
const OUT = 256; // saved picture (px)

/** Pick a picture, drag to move and zoom to frame it, save a square. */
export function ImageCrop({ target, onClose }: { target: CropTarget | null; onClose: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const [nat, setNat] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (target) return;
    setSrc((s) => (s && URL.revokeObjectURL(s), null));
    setNat({ w: 0, h: 0 });
    setBusy(false);
  }, [target]);

  const base = nat.w ? V / Math.min(nat.w, nat.h) : 1; // zoom 1 = picture just covers the square
  const k = base * zoom;
  const clamp = (x: number, y: number, kk = k) => ({ x: Math.min(0, Math.max(V - nat.w * kk, x)), y: Math.min(0, Math.max(V - nat.h * kk, y)) });

  const pick = (f?: File) => {
    if (!f) return;
    if (!f.type.startsWith('image/')) return void toast.error('Pick a picture file.');
    setSrc((s) => (s && URL.revokeObjectURL(s), URL.createObjectURL(f)));
    setNat({ w: 0, h: 0 });
    setZoom(1);
  };

  const loaded = () => {
    const { naturalWidth: w, naturalHeight: h } = img.current!;
    const b = V / Math.min(w, h);
    setNat({ w, h });
    setPos({ x: (V - w * b) / 2, y: (V - h * b) / 2 });
  };

  const zoomTo = (z: number) => {
    z = Math.min(4, Math.max(1, z));
    const kk = base * z;
    const cx = (V / 2 - pos.x) / k, cy = (V / 2 - pos.y) / k; // keep the centre where it is
    setPos(clamp(V / 2 - cx * kk, V / 2 - cy * kk, kk));
    setZoom(z);
  };

  const save = async () => {
    const c = document.createElement('canvas');
    c.width = c.height = OUT;
    const g = c.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img.current!, -pos.x / k, -pos.y / k, V / k, V / k, 0, 0, OUT, OUT);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.9));
    if (!blob) return void toast.error('Could not save that picture.');
    setBusy(true);
    try {
      await target!.save(blob);
      onClose();
    } catch (e: any) {
      toast.error(e.message);
      setBusy(false);
    }
  };

  const chooser = (
    <input type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
  );

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[352px]">
        <DialogHeader>
          <DialogTitle className="font-display text-xl font-extrabold tracking-tight">{target?.title}</DialogTitle>
          <DialogDescription>{src ? 'Drag to move. Zoom to fit.' : 'PNG, JPG or WebP.'}</DialogDescription>
        </DialogHeader>

        {src ? (
          <div className="grid gap-3">
            <div className="relative mx-auto touch-none overflow-hidden rounded-md border bg-muted select-none" style={{ width: V, height: V, cursor: drag.current ? 'grabbing' : 'grab' }}
              onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, ...pos }; }}
              onPointerMove={(e) => { const d = drag.current; if (d) setPos(clamp(d.x + e.clientX - d.px, d.y + e.clientY - d.py)); }}
              onPointerUp={() => (drag.current = null)}
              onWheel={(e) => zoomTo(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))}>
              <img ref={img} src={src} alt="" draggable={false} onLoad={loaded} className="absolute left-0 top-0 max-w-none"
                style={{ width: nat.w * k || V, transform: `translate(${pos.x}px, ${pos.y}px)`, visibility: nat.w ? 'visible' : 'hidden' }} />
              <div className="pointer-events-none absolute inset-0 rounded-md ring-1 ring-inset ring-white/20" />
            </div>
            <div className="flex items-center gap-2.5">
              <MagnifyingGlassMinus weight="bold" className="size-4 text-muted-foreground" />
              <Slider aria-label="Zoom" min={1} max={4} step={0.01} value={[zoom]} onValueChange={([z]) => zoomTo(z)} />
              <MagnifyingGlassPlus weight="bold" className="size-4 text-muted-foreground" />
            </div>
          </div>
        ) : (
          <label className={`mx-auto grid cursor-pointer place-items-center content-center gap-3 rounded-md border border-dashed transition-colors ${over ? 'border-primary bg-muted' : 'hover:bg-muted/60'}`}
            style={{ width: V, height: V }}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}>
            <ImageSquare weight="duotone" className="size-12 text-[var(--violet)]" />
            <span className="text-sm font-semibold">Choose or drop a picture</span>
            {chooser}
          </label>
        )}

        <DialogFooter className="gap-2">
          {src && <Button variant="ghost" className="mr-auto" asChild><label>Other picture{chooser}</label></Button>}
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!src || !nat.w || busy} onClick={save}>{busy && <CircleNotch weight="bold" className="animate-spin" />}Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
