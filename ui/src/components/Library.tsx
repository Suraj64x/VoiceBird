import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowBendUpRight, Article, ArrowsInSimple, ArrowsOutSimple, CaretRight, Copy, DotsThree, FolderSimple, FolderSimplePlus, ImageSquare, MagnifyingGlass, Microphone, PencilSimple, Plus, Star, Trash, Tray, X, MicrophoneStage } from '@phosphor-icons/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ago, api, folderImg, voiceImg, voiceUrl, type Folder, type ProjectInfo, type Voice } from '@/api';
import { cn } from '@/lib/utils';
import { Avatar, HUES, Section, Tile } from './bits';
import type { CropTarget } from './ImageCrop';
import { Player } from './Player';
import { BugReport } from './BugReport';

export type Ask = { title: string; body: string; yes: string; run: () => void; alt?: { label: string; run: () => void } };
export type Rename = { title: string; value: string; run: (name: string) => void };

const DRAG = 'text/x-voicebird-project';
/** Same id, same colour: a cheap string hash over the hue list. */
const hueOf = (id: string) => HUES[([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0) >>> 0) % HUES.length];
// one card look for voices, folders and projects; the selected one takes the area's hue
const card = 'group flex items-center gap-1 rounded-md border p-1.5 pr-1 transition-colors';
const picked = 'border-hue/60 bg-hue-soft';
const idle = 'hover:border-input hover:bg-muted';
// the "…" button stays out of the way until the card is hovered, focused or its menu is open
const reveal = 'size-7 opacity-0 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100';
const upload = (url: string) => (blob: Blob) => {
  const fd = new FormData();
  fd.append('file', blob, 'picture.webp');
  return api.form(url, fd);
};

function Menu({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('size-8 shrink-0 text-muted-foreground', className)} aria-label={label} title={label}><DotsThree weight="bold" /></Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Library(p: {
  voices: Voice[]; activeVoice?: string; onUseVoice: (id: string) => void; onNewVoice: () => void; onMoods: (v: Voice) => void; reloadVoices: () => Promise<unknown>;
  folders: Folder[]; projects: ProjectInfo[]; current?: string; reload: () => Promise<unknown>;
  onOpen: (id: string) => void; onCreate: (folder: string | null) => void; onRenameCurrent: (name: string) => void; onDeleted: (id: string) => void;
  ask: (a: Ask) => void; rename: (r: Rename) => void; crop: (c: CropTarget) => void;
}) {
  const { voices, folders, projects, current } = p;
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.closedFolders || '[]')); } catch { return new Set(); } });
  const [over, setOver] = useState<string | null>(null); // folder id or 'root' while dragging a project over it
  useEffect(() => { try { localStorage.closedFolders = JSON.stringify([...closed]); } catch { /* private mode */ } }, [closed]);

  const guard = (fn: () => Promise<unknown>) => fn().catch((e) => toast.error(e.message));
  const toggle = (id: string) => setClosed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const inFolder = useMemo(() => {
    const m = new Map<string | null, ProjectInfo[]>();
    for (const pr of projects) {
      const k = pr.folder && folders.some((f) => f.id === pr.folder) ? pr.folder : null;
      m.set(k, [...(m.get(k) ?? []), pr]);
    }
    return m;
  }, [projects, folders]);
  const hits = q.trim() ? projects.filter((pr) => pr.name.toLowerCase().includes(q.trim().toLowerCase())) : null;

  // ---------- actions ----------
  const move = (id: string, folder: string | null) => guard(async () => {
    await api.patch(`/projects/${id}`, { folder });
    if (folder) setClosed((c) => { const n = new Set(c); n.delete(folder); return n; });
    await p.reload();
  });
  const newFolder = () => p.rename({ title: 'New folder', value: '', run: (name) => guard(async () => { await api.post('/folders', { name }); await p.reload(); }) });
  const deleteFolder = (f: Folder) => {
    const n = inFolder.get(f.id)?.length ?? 0;
    const drop = (mode: string) => guard(async () => { await api.del(`/folders/${f.id}?projects=${mode}`); await p.reload(); if (mode === 'delete' && current && inFolder.get(f.id)?.some((x) => x.id === current)) p.onDeleted(current); });
    p.ask(n
      ? { title: `Delete "${f.name}"?`, body: `It holds ${n} project${n > 1 ? 's' : ''}.`, yes: 'Delete with projects', run: () => drop('delete'), alt: { label: 'Keep projects', run: () => drop('keep') } }
      : { title: `Delete "${f.name}"?`, body: 'The folder is empty.', yes: 'Delete folder', run: () => drop('keep') });
  };
  const deleteAllFolders = () => {
    const n = projects.filter((x) => x.folder && folders.some((f) => f.id === x.folder)).length;
    const drop = (mode: string) => guard(async () => { await api.del(`/folders?projects=${mode}`); await p.reload(); if (mode === 'delete' && current && !projects.some((x) => x.id === current && !x.folder)) p.onDeleted(current); });
    p.ask({ title: `Delete all ${folders.length} folders?`, body: n ? `They hold ${n} project${n > 1 ? 's' : ''}.` : 'They are all empty.', yes: n ? 'Delete with projects' : 'Delete folders', run: () => drop(n ? 'delete' : 'keep'), alt: n ? { label: 'Keep projects', run: () => drop('keep') } : undefined });
  };
  const deleteProject = (pr: ProjectInfo) => p.ask({
    title: `Delete "${pr.name || 'Untitled script'}"?`, body: 'The script and all its takes are removed from this PC.', yes: 'Delete project',
    run: () => guard(async () => { await api.del(`/projects/${pr.id}`); await p.reload(); p.onDeleted(pr.id); }),
  });
  const renameProject = (pr: ProjectInfo) => p.rename({
    title: 'Rename project', value: pr.name,
    run: (name) => (pr.id === current ? p.onRenameCurrent(name) : guard(async () => { await api.patch(`/projects/${pr.id}`, { name }); await p.reload(); })),
  });
  const duplicate = (pr: ProjectInfo) => guard(async () => { const c = await api.post<{ id: string }>(`/projects/${pr.id}/duplicate`); await p.reload(); p.onOpen(c.id); });
  const patchVoice = (v: Voice, body: Partial<Voice>) => guard(async () => { await api.patch(`/voices/${v.id}`, body); await p.reloadVoices(); });

  const dropZone = (folder: string | null) => ({
    onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); e.stopPropagation(); setOver(folder ?? 'root'); } },
    onDragLeave: (e: DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); },
    onDrop: (e: DragEvent) => { e.preventDefault(); e.stopPropagation(); setOver(null); const id = e.dataTransfer.getData(DRAG); if (id) move(id, folder); },
  });

  // ---------- rows ----------
  const projectRow = (pr: ProjectInfo, hint?: string) => (
    <li key={pr.id} draggable onDragStart={(e) => { e.dataTransfer.setData(DRAG, pr.id); e.dataTransfer.effectAllowed = 'move'; }} className={cn(card, 'relative', pr.id === current ? picked : idle)}>
      {/* the text runs under the hidden "…" and only makes room for it when it shows */}
      <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left group-hover:pr-8 group-has-[:focus-visible]:pr-8 group-has-[[data-state=open]]:pr-8" onClick={() => p.onOpen(pr.id)} aria-current={pr.id === current}>
        <Avatar icon={Article} hue={hueOf(pr.id)} size={30} />
        <span className="grid min-w-0">
          <span className="truncate text-sm font-semibold leading-snug">{pr.name || 'Untitled script'}</span>
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            {hint && <FolderSimple weight="bold" className="size-3 shrink-0" />}
            <span className="truncate tabular-nums">{hint && `${hint} · `}{pr.words} words · {ago(pr.updated)}</span>
          </span>
        </span>
      </button>
      <Menu label={`Options for ${pr.name || 'Untitled script'}`} className={cn(reveal, 'absolute right-1 top-1/2 -translate-y-1/2')}>
        <DropdownMenuItem onSelect={() => renameProject(pr)}><PencilSimple /> Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => duplicate(pr)}><Copy /> Duplicate</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2"><ArrowBendUpRight className="size-4 text-muted-foreground" /> Move to</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44">
            <DropdownMenuItem disabled={!pr.folder} onSelect={() => move(pr.id, null)}><Tray /> No folder</DropdownMenuItem>
            {folders.length > 0 && <DropdownMenuSeparator />}
            {folders.map((f) => <DropdownMenuItem key={f.id} disabled={pr.folder === f.id} onSelect={() => move(pr.id, f.id)}><FolderSimple /> {f.name}</DropdownMenuItem>)}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => p.rename({ title: 'New folder', value: '', run: (name) => guard(async () => { const f = await api.post<Folder>('/folders', { name }); await move(pr.id, f.id); }) })}><FolderSimplePlus /> New folder…</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => deleteProject(pr)}><Trash /> Delete</DropdownMenuItem>
      </Menu>
    </li>
  );

  return (
    <aside className="quiet-scroll flex flex-col border-b bg-background lg:overflow-y-auto lg:border-b-0 lg:border-r">
      {/* ---------- voices ---------- */}
      <Section icon={Microphone} title="Voices" hue="violet" action={<Button size="icon" variant="outline" className="size-7" aria-label="New voice" title="New voice" onClick={p.onNewVoice}><Plus weight="bold" /></Button>}>
        {voices.length === 0 ? (
          <div className="grid justify-items-center gap-3 py-3">
            <Tile big icon={Microphone} />
            <Button onClick={p.onNewVoice}><Plus weight="bold" /> Add a voice</Button>
          </div>
        ) : (
          <ul className="grid gap-1">
            {voices.map((v) => {
              const on = p.activeVoice === v.id;
              return (
                <li key={v.id} className={cn(card, on ? picked : idle)}>
                  <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left" onClick={() => p.onUseVoice(v.id)} aria-pressed={on} title="Use this voice">
                    <Avatar src={voiceImg(v)} letter={v.name.charAt(0).toUpperCase()} hue={hueOf(v.id)} size={34} />
                    <span className="grid min-w-0">
                      <span className="flex min-w-0 items-center gap-1 text-sm font-semibold leading-snug"><span className="truncate">{v.name}</span>{v.default && <Star weight="fill" className="size-3 shrink-0 text-[var(--amber)]" aria-label="default" />}</span>
                      <span className="truncate text-xs tabular-nums text-muted-foreground">{v.duration.toFixed(0)} s sample</span>
                    </span>
                  </button>
                  <Player compact src={voiceUrl(v)} label={`${v.name} sample`} />
                  <Menu label={`Options for ${v.name}`}>
                    <DropdownMenuItem disabled={v.default} onSelect={() => patchVoice(v, { default: true })}><Star /> Set as default</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => p.onMoods(v)}><MicrophoneStage /> Mood samples…</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => p.rename({ title: 'Rename voice', value: v.name, run: (name) => patchVoice(v, { name }) })}><PencilSimple /> Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => p.crop({ title: v.image ? 'Change picture' : 'Add picture', save: async (b) => { await upload(`/voices/${v.id}/image`)(b); await p.reloadVoices(); } })}><ImageSquare /> {v.image ? 'Change picture' : 'Add picture'}</DropdownMenuItem>
                    {!!v.image && <DropdownMenuItem onSelect={() => guard(async () => { await api.del(`/voices/${v.id}/image`); await p.reloadVoices(); })}><X /> Remove picture</DropdownMenuItem>}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => p.ask({ title: `Delete "${v.name}"?`, body: 'The voice sample is removed. Voice-overs you already made stay.', yes: 'Delete voice', run: () => guard(async () => { await api.del(`/voices/${v.id}`); await p.reloadVoices(); }) })}><Trash /> Delete</DropdownMenuItem>
                  </Menu>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {/* ---------- projects + folders ---------- */}
      <Section icon={FolderSimple} title="Projects" hue="blue" className="border-b-0" action={
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="size-7" aria-label="New project" title="New project" onClick={() => p.onCreate(null)}><Plus weight="bold" /></Button>
          <Button size="icon" variant="outline" className="size-7" aria-label="New folder" title="New folder" onClick={newFolder}><FolderSimplePlus weight="bold" /></Button>
          <Menu label="More project options" className="size-7">
            <DropdownMenuItem onSelect={newFolder}><FolderSimplePlus /> New folder</DropdownMenuItem>
            <DropdownMenuItem disabled={!folders.length} onSelect={() => setClosed(new Set())}><ArrowsOutSimple /> Open all folders</DropdownMenuItem>
            <DropdownMenuItem disabled={!folders.length} onSelect={() => setClosed(new Set(folders.map((f) => f.id)))}><ArrowsInSimple /> Close all folders</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={!folders.length} onSelect={deleteAllFolders}><Trash /> Delete all folders…</DropdownMenuItem>
          </Menu>
        </div>
      }>
        <label className="mb-2 flex h-9 items-center gap-2 rounded-md border bg-background px-2.5 focus-within:border-ring">
          <MagnifyingGlass weight="bold" className="size-4 shrink-0 text-muted-foreground" />
          <input className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" placeholder="Search" aria-label="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button className="text-muted-foreground hover:text-foreground" aria-label="Clear search" onClick={() => setQ('')}><X weight="bold" className="size-3.5" /></button>}
        </label>

        {hits ? (
          <ul className="grid gap-1">
            {hits.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">No match</li>}
            {hits.map((pr) => projectRow(pr, folders.find((f) => f.id === pr.folder)?.name))}
          </ul>
        ) : (
          <ul className={cn('grid min-h-16 content-start gap-1 rounded-md transition-colors', over === 'root' && 'bg-hue-soft ring-1 ring-hue')} {...dropZone(null)}>
            {folders.map((f) => {
              const items = inFolder.get(f.id) ?? [];
              const open = !closed.has(f.id);
              return (
                <li key={f.id} className={cn('rounded-md transition-colors', over === f.id && 'bg-hue-soft ring-1 ring-hue')} {...dropZone(f.id)}>
                  <div className={cn(card, 'bg-muted/60', over === f.id ? 'border-hue/60' : idle)}>
                    <button className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-left" onClick={() => toggle(f.id)} aria-expanded={open}>
                      <Avatar src={folderImg(f)} icon={FolderSimple} hue={hueOf(f.id)} size={30} />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-semibold">
                        <span className="truncate">{f.name}</span>
                        <CaretRight weight="bold" className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-150', open && 'rotate-90')} />
                      </span>
                    </button>
                    {/* the count sits where the "…" button appears on hover */}
                    <span className="relative grid size-7 shrink-0 place-items-center">
                      <span className="min-w-5 rounded-sm border bg-background px-1 text-center text-[11px] font-semibold leading-[18px] tabular-nums text-muted-foreground transition-opacity group-hover:opacity-0 group-has-[:focus-visible]:opacity-0 group-has-[[data-state=open]]:opacity-0">{items.length}</span>
                      <Menu label={`Options for folder ${f.name}`} className={cn(reveal, 'absolute inset-0')}>
                        <DropdownMenuItem onSelect={() => p.onCreate(f.id)}><Plus /> New project here</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => p.rename({ title: 'Rename folder', value: f.name, run: (name) => guard(async () => { await api.patch(`/folders/${f.id}`, { name }); await p.reload(); }) })}><PencilSimple /> Rename</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => p.crop({ title: f.image ? 'Change picture' : 'Add picture', save: async (b) => { await upload(`/folders/${f.id}/image`)(b); await p.reload(); } })}><ImageSquare /> {f.image ? 'Change picture' : 'Add picture'}</DropdownMenuItem>
                        {!!f.image && <DropdownMenuItem onSelect={() => guard(async () => { await api.del(`/folders/${f.id}/image`); await p.reload(); })}><X /> Remove picture</DropdownMenuItem>}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => deleteFolder(f)}><Trash /> Delete folder…</DropdownMenuItem>
                      </Menu>
                    </span>
                  </div>
                  {open && (
                    <ul className="ml-[21px] mt-1 grid gap-1 border-l pl-2">
                      {items.length ? items.map((pr) => projectRow(pr)) : <li className="py-1.5 pl-1 text-xs text-muted-foreground">Drop projects here</li>}
                    </ul>
                  )}
                </li>
              );
            })}
            {(inFolder.get(null) ?? []).map((pr) => projectRow(pr))}
          </ul>
        )}
      </Section>
      <div className="mt-auto border-t bg-background p-2 lg:sticky lg:bottom-0"><BugReport /></div>
    </aside>
  );
}
