# Markdown (`ui/markdown.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

```js
import { markdownElement, updateMarkdown, renderMarkdown, markdownLine, copyText } from '/apps/_citadel/ui/markdown.js';

box.append(markdownElement(text));                // a div.cui-md, its styles adopted
updateMarkdown(replyEl, textSoFar, { streaming: true });  // on every chunk; only changed blocks redraw
updateMarkdown(replyEl, fullText);                // once the reply is done
button.innerHTML = markdownLine(text);            // a line or two for a preview: no links, "• " items
```

Options (each optional): `breaks` (keep single line breaks: chat true, documents false),
`streaming` (holds back a half table row and a header without its separator, a bare list marker;
closes a half `**`, `` ` `` or `[link`), `headingBase` (the level `#` draws as: 3 by default so a
reply sits under your page's headings; a document passes 1), and hooks `link(href, html)`,
`image(href, alt, title)`, `text(html)` returning HTML.

- Output is escaped first; the only tags are the renderer's own, so `innerHTML` with it is safe.
- Default links: http(s) and mailto open a new tab (`_blank`, `rel=noopener`); anything else is an
  inert `span.cui-link`. A `link` hook for your own paths should still never use `target="_top"`:
  inside Citadel's frame that takes the person out of Citadel.
- Fenced code blocks drawn by `markdownElement`/`updateMarkdown` get a Copy button
  (`.cui-copy`, top right, shown on hover; always on a phone) that copies the code exactly. For
  your own Copy buttons, `copyText(text)` resolves whether it worked and also works on plain http.
- Styles come only through `markdownElement`/`updateMarkdown`; `renderMarkdown` alone is a string,
  for tests and servers. Preact: `updateMarkdown(ref.current, text, opts)` in a `useEffect`, with
  nothing rendered into that element.
