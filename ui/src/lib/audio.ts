import { useSyncExternalStore } from 'react';

/** One audio element for the whole app, so playback keeps going while you switch project, folder or tab. */
export type Track = { src: string; title: string; sub?: string };
type State = { track: Track | null; playing: boolean; time: number; duration: number; rate: number };

const el = new Audio();
el.preload = 'auto';
let state: State = { track: null, playing: false, time: 0, duration: 0, rate: 1 };
const subs = new Set<() => void>();
const set = (patch: Partial<State>) => { state = { ...state, ...patch }; subs.forEach((f) => f()); };

el.addEventListener('play', () => set({ playing: true }));
el.addEventListener('pause', () => set({ playing: false }));
el.addEventListener('timeupdate', () => set({ time: el.currentTime }));
el.addEventListener('durationchange', () => { if (isFinite(el.duration)) set({ duration: el.duration }); });
el.addEventListener('ended', () => set({ playing: false, time: 0 }));
el.addEventListener('error', () => set({ playing: false }));

const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
session?.setActionHandler('play', () => audio.toggle());
session?.setActionHandler('pause', () => audio.pause());
session?.setActionHandler('seekbackward', () => audio.seek(state.time - 5));
session?.setActionHandler('seekforward', () => audio.seek(state.time + 5));

export const audio = {
  play(t: Track, at?: number) {
    if (state.track?.src !== t.src) {
      el.src = t.src;
      el.playbackRate = state.rate;
      set({ track: t, time: 0, duration: 0 });
      if (session) session.metadata = new MediaMetadata({ title: t.title, artist: t.sub || 'VoiceBird' });
    }
    if (at != null) el.currentTime = Math.max(0, at);
    el.play().catch(() => set({ playing: false }));
  },
  toggle(t?: Track) {
    if (t && state.track?.src !== t.src) return audio.play(t);
    if (!state.track) return;
    if (el.paused) el.play().catch(() => set({ playing: false }));
    else el.pause();
  },
  pause() { el.pause(); },
  seek(to: number) {
    if (!state.track) return;
    el.currentTime = Math.max(0, Math.min(state.duration || el.duration || 0, to));
    set({ time: el.currentTime });
  },
  rate(r: number) { el.playbackRate = r; set({ rate: r }); },
  close() {
    el.pause();
    el.removeAttribute('src');
    el.load();
    set({ track: null, playing: false, time: 0, duration: 0 });
  },
  get state() { return state; },
};

export const useAudio = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => state);
