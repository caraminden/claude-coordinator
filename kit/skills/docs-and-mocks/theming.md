# A scheme's theme

Every page uses the kit's `--mk-*` tokens, so a scheme changes its look in one file. The kit's
default is Citadel's look, light and dark with the system setting.

A scheme with its own look keeps one `theme.css` in its design folder, copied beside each page and
linked after `mockkit.css`. It sets the tokens, and may load fonts and style headings:

```css
@import url("https://fonts.googleapis.com/css2?family=…&display=swap");  /* first line, if any */
:root, :root:not([data-mk-light]) {   /* both selectors: beats the kit's dark block too */
  --mk-bg: #0f1014;        /* the page */
  --mk-panel: #1f2129;     /* boards, cards, tables */
  --mk-sunk: #1a1c24;      /* stages, code, table heads */
  --mk-ink: #e6e3dc;       /* body text */
  --mk-muted: #9ea8bd;     /* secondary text */
  --mk-line: #34364a;      /* borders */
  --mk-accent: #f2c761;    /* the one action, links, the recommendation */
  --mk-on-accent: #15161c; /* text on accent */
  --mk-good: #8cd98c;  --mk-warn: #f2d14d;  --mk-bad: #f2594d;  --mk-info: #8cb3f2;
  --mk-font: "Open Sans", system-ui, sans-serif;
  --mk-display: "Alegreya Sans SC", serif;   /* headings */
  --mk-mono: ui-monospace, monospace;
  --mk-radius: 5px;  --mk-radius-sm: 3px;
  --mk-shadow: none;
  color-scheme: dark;
}
.mk h1, .mk h2, .mk h3 { color: var(--mk-accent); }
```

- Take every value from the scheme's own source (its stylesheet, its game's UI constants, its
  design-system home) and comment where each came from. For a contraption, that is its own
  stylesheet and, under Citadel UI, the `--citadel-*` tokens in `theme.css` (the `citadel:contraption-ui` skill).
- Keep tones meaning what they mean in the kit: good is chosen or has, bad is cut or stops, warn is
  rework or waiting.
- The theme styles the document. A mocked screen inside a board is drawn in the page's own styles
  with the scheme's real values, so it looks like the real screen.
- Icon or art paths the scheme's pages share go in the theme's comment, with the folder to copy them from.
