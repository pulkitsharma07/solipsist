# Making an image

The page shows images the way GitHub renders a README: a markdown image whose path is relative to the page's folder.
Put it on a line of its own, with a blank line before and after, or inline in a sentence, and always give it a short
alt text saying what it shows.

Make the image with a one-off script: Python 3 (`python3 - <<'EOF' … EOF`) or JavaScript (`bun -e '…'` or
`node -e '…'`), run inline from Bash, that writes one `.svg` file straight into the image folder your prompt names, the
only place you can write. Don't save the script anywhere. There is no network, so install nothing: use the standard
library and write the SVG markup yourself (a chart is a few rects, lines and text, with the scales computed in the
script). Give the file a short descriptive name in kebab-case (`signup-funnel.svg`); never overwrite a file that is
already there, so pick a new name. Then link it exactly as your prompt shows: `images/`, the link folder it names, and the file name
(`![Signups by week, rising from 120 to 310](images/<link folder>/signups-by-week.svg)`). The link folder is the page's
file name; it is not the end of the path you write the file to, so copy it from the prompt's link, not from that path.

Draw only what the page supports: never invent data for a chart. If you can't make a good one, write text or a table
instead.

## How it looks

Like a figure from a modern SaaS product's docs or dashboard (Linear, Stripe, Vercel): calm, clean and precise.

- **Canvas**: `xmlns="http://www.w3.org/2000/svg"`, a `viewBox` and matching `width` and `height` (about 720 wide,
  280–440 tall), so it opens on its own. A full-size `rect` as the card: fill `#ffffff`, 1px stroke `#e5e7eb`, corner
  radius 12. The card keeps it readable on the app's light and dark themes alike. Padding of at least 24 inside it.
- **Type**: `font-family="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`.
  Title 16, weight 600, `#111827`, top left; an optional subtitle 13, `#6b7280`, below it. Labels 12, `#6b7280`;
  values 12, weight 500, `#374151`. Sentence case, no all-caps titles, no text smaller than 11. Numbers formatted for
  people (`12.4k`, `38%`, `$1.2M`) with `font-variant-numeric: tabular-nums`.
- **Colour**: neutral greys for everything that isn't data. One accent for the data, `#6366f1` (indigo); for more
  series, in this order, `#0ea5e9`, `#10b981`, `#f59e0b`, `#f43f5e`, `#8b5cf6`, and at most five. Highlight the one
  thing that matters in the accent and draw the rest in `#c7d2fe` or `#d1d5db`. Tinted fills (the accent at 10–15%
  opacity) for areas and boxes. No neon, no rainbow, no gradients beyond a faint one under a line.
- **Charts**: gridlines only horizontal, 1px `#f3f4f6`; no chart border, no axis line on the value axis, a 1px
  `#e5e7eb` baseline. Bars with rounded tops (radius 4), a gap of about 30–40% between them. Lines 2px with round
  joins and caps, a 3.5 radius dot only on the points worth reading. Label the series directly at their ends instead
  of a legend where you can; label the values that matter instead of making the reader trace them. Value axes start
  at 0 for bars. 4–6 ticks, round numbers.
- **Diagrams**: boxes with radius 8, fill `#f9fafb`, 1px stroke `#e5e7eb`, text centred, one box in the accent tint
  for the focus. Arrows 1.5px `#9ca3af` with a small solid head, straight or with right-angle bends, never crossing a
  box. Line things up on a grid with even spacing; keep the reading direction left to right or top to bottom.
- **Never**: 3D, drop shadows, clip art, emoji, decorative icons, pie charts with more than four slices, text that
  overlaps or runs off the card. Check the coordinates in the script so labels fit (about 7px per character at 12px).
  Keep it simple: fewer, larger elements are better.
