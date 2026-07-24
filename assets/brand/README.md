# MonoX brand guidelines

## Core idea

MonoX turns defined boundaries into a dependable delivery path.

- The navy M is the boundary structure.
- The blue X is the reusable delivery path.
- The yellow diamond is the contract junction.
- The right-side terminal makes the output direction explicit.

Approved tagline: `Boundaries in. Path out.`

Always write the name as `MonoX`.

## Palette

| Token  | Hex       | Primary use                          |
| ------ | --------- | ------------------------------------ |
| Ink    | `#07111F` | Primary mark, type, dark background  |
| Navy   | `#0B1728` | Raised dark surfaces                 |
| Blue   | `#4F7CFF` | Delivery path, action accent         |
| Yellow | `#FFC83D` | Contract junction, focused accent    |
| Paper  | `#F7F9FC` | Light background, reverse mark       |
| Slate  | `#9AA9BE` | Secondary type on dark surfaces      |
| Line   | `#2B3E58` | Diagrams and low-emphasis boundaries |

Use the color mark only on Paper, white, or similarly light neutral backgrounds. Use the reverse mark on Ink
or Navy. Use the mono mark when production is limited to one color.

## Clearspace

Let `x` equal the width of the yellow diamond. Keep at least `1x` clear on every side of the standalone mark
and every lockup. No type, border, image edge, or other graphic may enter this area.

## Minimum sizes

| Asset             | Digital     | Print          |
| ----------------- | ----------- | -------------- |
| Standard mark     | 24 px high  | 8 mm high      |
| Favicon           | 16 px       | Not applicable |
| Horizontal lockup | 160 px wide | 32 mm wide     |
| Stacked lockup    | 96 px wide  | 24 mm wide     |

At 16 px and 32 px, use `monox-favicon.svg` or `monox-favicon.png`. Do not scale the standard mark down as a
substitute.

## Logo usage

Do:

- Use the supplied SVG whenever vector output is supported.
- Use the supplied PNG at its native size or scale it down proportionally.
- Preserve the exact geometry, proportions, colors, and clearspace.
- Use the color, reverse, or mono variant that matches the background.

Do not:

- Recolor, rotate, skew, stretch, outline, crop, or redraw the mark.
- Remove or move the yellow contract junction.
- Remove, mirror, or extend the right-side output terminal.
- Add gradients, shadows, glows, textures, or extra containers.
- Put the color mark directly on Ink, Navy, photography, or a busy pattern.
- Typeset a replacement for the geometric MonoX wordmark.

## Asset inventory

| File                              | Purpose                           | PNG size    |
| --------------------------------- | --------------------------------- | ----------- |
| `monox-mark-color`                | Primary mark on light backgrounds | 1024 x 1024 |
| `monox-mark-mono`                 | One-color production              | 1024 x 1024 |
| `monox-mark-reverse`              | Mark on Ink or Navy               | 1024 x 1024 |
| `monox-lockup-horizontal-color`   | Primary horizontal lockup         | 1600 x 512  |
| `monox-lockup-horizontal-reverse` | Reverse horizontal lockup         | 1600 x 512  |
| `monox-lockup-stacked-color`      | Primary stacked lockup            | 1200 x 1080 |
| `monox-lockup-stacked-reverse`    | Reverse stacked lockup            | 1200 x 1080 |
| `monox-favicon`                   | Browser and compact UI icon       | 64 x 64     |
| `monox-app-icon`                  | App and launcher icon             | 1024 x 1024 |
| `monox-og`                        | Website social preview            | 1200 x 630  |
| `monox-github-social`             | GitHub social preview             | 1280 x 640  |
| `monox-readme-header`             | README and npm header             | 1280 x 320  |

Transparent PNGs are supplied for marks and lockups. Favicon, app icon, social cards, and QA boards use an
opaque background.
