# VoiceBird: design system

The owner's direction: a real desktop-app feel. Dark like GitHub but with better colours, green, boxy, professional, minimal text, bold big type, good fonts, proper icons, small illustrations.

## Shell
- Full-window app, no page scroll on desktop: 48px top bar, three panes (264px library · flexible editor · 320px inspector), each scrolling on its own. A fixed action bar sits at the bottom of the editor.
- Under 1024px the panes stack and the page scrolls; the action bar stays pinned.
- Panes are separated by 1px lines, not floating cards. No shadows, gradients or glass.

## Colour (tokens in `ui/src/index.css`)
- Neutrals carry a faint green cast. Dark: page `#080b0a`, panes `#0d1211`, raised `#141b19`, lines `#212a27`, text `#e9f0ed`, quiet text `#8fa099`.
- One accent: vivid green `#2fdb73` (light mode `#22c55e`) with near-black text on it. Used only for the primary action, the current selection (`--tint` background + green border) and live state.
- `--success` is the green used for icons and small text; red is only for destructive actions and errors; amber only for "loading".
- Light mode exists (toggle in the top bar) and uses the same roles.

## Type
- **Bricolage Grotesque** (700–800) for titles, pane headings and big numbers. **Outfit** for everything else. **Geist Mono** for time, seeds and measurements.
- Fixed sizes: 11 / 12 / 13 / 14 (body) / 15 (pane headings) / 17 (script) / 20 (stats) / 28 (project title).
- Sentence case. No all-caps labels except the wordmark.

## Shape and controls
- Every corner is 6px (4px for tiny parts). 1px borders.
- Components are shadcn/ui (Radix) restyled by tokens: Button, Select, Slider, Switch, Dialog, Dropdown menu; Sonner for toasts; NumberFlow for counting numbers; Lucide icons at 1.75 stroke.
- Selected things share one look: green border + `--tint` fill (voice, project, emotion chip, chosen take, export toggles).
- Icon-only buttons always have an `aria-label` and a `title`.

## Sound-specific pieces
- Every take shows its real waveform (96 bars from the server); the played part turns green. Click or arrow keys to seek.
- Emotions are a 4×2 grid of icon chips, not a dropdown.
- While a paragraph is being spoken it shows three small moving level bars (the only decorative motion; off under reduced-motion).

## Copy
- As few words as possible. Helper sentences only where a choice has consequences (licence line under the engine, delete confirmations).
- Empty states show a small line illustration and one bold line.
