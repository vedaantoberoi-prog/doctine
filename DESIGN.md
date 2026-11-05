# Doctine design system

One visual language for the website (`website/`) and the app (`public/index.html`). Tokens live in
`website/assets/site.css` (website) and the `:root` blocks at the top of `public/index.html` (app); keep them in step.

## Positioning

- **Idea:** Personal health, connected.
- **Today:** a private personal health record (profile, reports, prescriptions, medicines, dose history).
- **Direction:** a connected health-information layer: records → understanding → reliable knowledge → connected care.
  Only the first layer exists. Everything else is labelled *In development* or *Planned* wherever it appears.
- **Voice:** calm, precise, plain international English. No superlatives, no invented numbers, no clinical claims.
  Say what works; label what doesn't; deny rather than imply ("doesn't replace your doctor").

## Colour

| Token | Hex | Use |
|---|---|---|
| Midnight Navy | `#101C2B` | headings, primary buttons, dark bands, logo tile |
| Charcoal | `#202A35` | body text (12.9:1 on ivory) |
| Warm Ivory | `#F3F1EB` | page background |
| White | `#FFFFFF` | cards, inputs |
| Muted Sage | `#527D76` | accents, rules, icons, progress fills. **Not for small text** (4.1:1 on ivory) |
| Sage Deep | `#3F6660` | links and sage-coloured text (5.7:1 on ivory) — added because Muted Sage fails AA for text |
| Sage Wash | `#E3EBE8` | tinted panels, "available" labels |
| Silver Mist | `#D8DEE6` | lines, borders |
| Slate | `#5B6673` | secondary text (5.2:1 on ivory) |
| Amber wash / ink | `#F6EEDC` / `#6B4A0C` | "in development" labels only |

Dark mode uses `#0C1520` background, `#142131` surfaces, `#DCE2E9` text and `#8DB5AE` for sage text.
No gradients, no bright greens or saturated blues. Red is reserved for emergencies and errors.

## Type

- **Fraunces** (500/600, optical sizing): page and section headlines only.
- **Instrument Sans** (400/500/600): everything else, including card titles (`h3`) and all product UI.
- Numbers in records use `font-variant-numeric: tabular-nums` (`.num`).
- Scale: h1 `clamp(2.35rem, 6vw, 4rem)`, h2 `clamp(1.75rem, 3.4vw, 2.5rem)`, h3 1.25rem, body 1.0625rem/1.62,
  small .9375rem, eyebrow .8125rem uppercase +.09em.

## Logo

The mark is a rounded navy tile with an open "D" and a single point: a record, and the point it connects to.
It has no cross or heart, works at 16px, and has a one-colour version.

- `website/assets/brand/doctine-mark.svg` (colour), `doctine-mark-mono.svg` (one colour, `currentColor`),
  `doctine-wordmark.svg` (mark + Fraunces wordmark). Favicon: `website/favicon.svg`.
- Colours: tile `#101C2B`, D `#F3F1EB`, point `#8DB5AE`. On dark backgrounds the tile gets a `#3A4C63` outline.
- Keep at least half the tile's width clear around it. Don't recolour the point, rotate, or add effects.

## Space, shape, elevation

- 4px base: `--s1` .25rem … `--s9` 6.5rem. Sections: 4.5rem (mobile) / 6.5rem (desktop) vertical padding.
- Radius: 8px (small controls), 14px (notices, menus), 22px (cards), pill (buttons, labels).
- One shadow (`--shadow`) for floating things only: the record illustration and menus.

## Components (website)

| Component | Class | Notes |
|---|---|---|
| Button | `.btn`, `.btn.ghost`, `.btn.sm` | ≥48px tall (40px for `.sm`); full width under 480px |
| Status label | `.status.now` / `.dev` / `.later` | the only way to describe availability |
| Feature card | `.feature` | icon (line, 1.6 stroke), h3, one short paragraph |
| Split section | `.section` + `.split` | heading left, content right on desktop; stacked on mobile |
| Dark band | `.band` | one per page at most |
| Notice | `.notice`, `.notice.urgent` | safety and emergency messages |
| Layers | `.layers` / `.layer` | the vision; each row carries a status label |
| Long-form | `.page-head` + `.prose`, `.table-wrap` + `.stack-table` | policies; tables stack under 560px |
| Header / footer | `.site-head`, `.menu`, `.site-foot` | identical on every page (checked by `tests/browser/website.test.mjs`) |

## App conventions

- Tokens: `--navy --text --card --hover --tealtx --teal --tealbg --bg --line --mute` map to the palette above
  (the `teal*` names are historical and now hold the sage values).
- Navigation shows only sections that work. Icons are 18px line icons (`NAVI`), never emoji.
- States: `.warn` (amber) for limits and notices, `.err` (red) for failures, empty states are a single sentence in
  `--mute` with the next action as a button. Loading is said in words ("Saving…").
- When a capability isn't switched on (`aiOff()`), say so before the person tries it, and hide shortcuts that lead
  nowhere.

## Accessibility

- Text contrast ≥ 4.5:1; large text and UI ≥ 3:1 (see the table above).
- Visible focus ring: 3px sage outline, 3px offset.
- Tap targets ≥ 40px; no horizontal scrolling from 320px up (tested).
- `prefers-reduced-motion` disables smooth scrolling and transitions.
