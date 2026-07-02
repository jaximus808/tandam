# Tandem — Logo Asset Pack

The Tandem mark: two riders hitched to one orbit — a solid bead (the agent) and an
outlined bead (the human), moving together on a shared path. Deep teal, medium weight.

## Colors
- **Teal** `#0D6E66` — primary brand color (icon tile, wordmark on light backgrounds)
- **White** `#FFFFFF` — the mark on the teal tile / on any dark or colored surface
- **Paper** `#FBFAF8` — the recommended light background
- Wordmark typeface: **Fraunces**, weight 600 (Google Fonts)

## What to use when

### Website favicon / browser tab
`svg/tandem-favicon.svg` (scales to any size, sharpest) — or the PNGs in
`png/favicon/` (`16`, `32`, `48`). Most sites: link the SVG, keep the 32px PNG as fallback.

### App icon (iOS / Android / desktop / PWA)
`png/icon/` has the teal tile at `1024, 512, 256, 192, 180, 128, 64, 48`.
- iOS app store: `1024`. Android / PWA: `512` + `192`. Apple touch icon: `180`.
- Prefer `svg/tandem-icon-teal.svg` anywhere SVG is accepted.

### The mark on your own background (no tile)
`png/mark/` — transparent PNGs at `1024/512/256` in two versions:
- `tandem-mark-white-*` — for dark or colored backgrounds
- `tandem-mark-teal-*` — for light / paper backgrounds
Or the vectors: `svg/tandem-mark-white.svg`, `svg/tandem-mark-teal.svg`.

### Logo + wordmark (slides, docs, headers, email)
`png/lockup/tandem-lockup-horizontal.png` and `…-stacked.png` (on paper).
Vector: `svg/tandem-lockup-horizontal.svg`, `svg/tandem-lockup-stacked.svg`
(these pull Fraunces from Google Fonts when opened in a browser).

### Social / link preview
`png/social/tandem-og-1200x630.png` — drop into an `og:image` / Twitter card.

### Animation
- `svg/tandem-icon-animated.svg` — self-contained, **loops** in any modern browser
  (use as `<img src>`, CSS background, or inline). The assembly: arcs draw in →
  bar connects the two → beads pop.
- `tandem-logo-animated.html` — a standalone page playing the same loop, for
  splash screens / kiosks / screen-recording into a GIF or video.

## Files
```
svg/    tandem-icon-teal · tandem-favicon · tandem-mark-white · tandem-mark-teal
        tandem-lockup-horizontal · tandem-lockup-stacked · tandem-icon-animated
png/icon/     1024 512 256 192 180 128 64 48   (teal tile)
png/favicon/  48 32 16                          (heavier weight for small sizes)
png/mark/     white & teal @ 1024 512 256       (transparent)
png/lockup/   horizontal · stacked              (on paper)
png/social/   og-1200x630
tandem-logo-animated.html
```

## Clear space & minimum size
Keep clear space of one bead-diameter around the mark. Don't recolor the mark
outside teal/white, rotate it, or add effects. Minimum: 16px (use the favicon
build below 24px — its strokes are thickened to stay legible).

_SVG is the source of truth — regenerate PNGs from it at any size you need._
