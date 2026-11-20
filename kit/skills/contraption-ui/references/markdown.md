# Markdown (`ui/markdown.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

```js
import { markdownElement, updateMarkdown, renderMarkdown, markdownLine, copyText, linkify } from '/apps/_citadel/ui/markdown.js';

box.append(markdownElement(text));                // a div.cui-md, its styles adopted
updateMarkdown(replyEl, textSoFar, { streaming: true });  // on every chunk; only changed blocks redraw
updateMarkdown(replyEl, fullText);                // once the reply is done
button.innerHTML = markdownLine(text);            // a line or two for a preview: no links, "• " items
cell.innerHTML = linkify(record.source);          // plain text, escaped, its URLs and DOIs as links
```

Options (each optional): `breaks` (keep single line breaks: chat true, documents false),
`streaming` (holds back a half table row and a header without its separator, a bare list marker;
closes a half `**`, `` ` `` or `[link`), `headingBase` (the level `#` draws as: 3 by default so a
reply sits under your page's headings; a document passes 1), and hooks `link(href, html)`,
`image(href, alt, title)`, `text(html)` returning HTML.

Marked pictures (#960): an image whose title is a marks title draws its marks over the picture, with a
Marks toggle under it. An agent writes them as `![Save button](shot.png "marks 1280x900: box 71 4 80 8;
arrow 52 20 70 7; pin 1 81 6; label 40 22 Click Save")`: the picture's own size, then marks split by `;`,
each a kind (`box`/`arrow` x1 y1 x2 y2, `pin` n x y, `label` x y words up to 40 characters), an optional
`red` or `yellow`, numbers in percent of the picture from its top left. A title with any wrong mark shows
the picture plain. Tell your app's agent this in its prompt if it should point at pictures.

- Output is escaped first; the only tags are the renderer's own, so `innerHTML` with it is safe.
- Bare URLs, `<https://…>`, DOIs (`10.1234/x`, `doi:10.1234/x`, to https://doi.org/) and web
  addresses with no scheme (`console.firebase.google.com/x`, to https://; only .com, .org, .net, .io,
  .dev, .app, .ai, .gov, .edu and .uk, so file names stay text) become links through the `link` hook,
  as `[text](href)` does; code spans stay text.
- Default links: http(s) and mailto open a new tab (`_blank`, `rel="noopener noreferrer"`); anything
  else is an inert `span.cui-link`. A `link` hook for your own paths should still never use `target="_top"`:
  inside Citadel's frame that takes the person out of Citadel.
- Fenced code blocks drawn by `markdownElement`/`updateMarkdown` get a Copy button
  (`.cui-copy`, top right, shown on hover; always on a phone) that copies the code exactly. For
  your own Copy buttons, `copyText(text)` resolves whether it worked and also works on plain http and in Citadel's
  frame, which gives an app no clipboard rights of its own (#1086): call it from the click itself, never on load.
- A fence tagged with where it runs gets a coloured header saying so (#898): `powershell-admin` (amber, "Run as
  administrator"), `powershell` (`ps1`, `pwsh`), `wsl`, `fish` (perigee), `bash` (`sh`, `zsh`, `shell`, `console`), `cmd`.
  Any other tag draws plain. **Rule for agents: every command a person runs by hand goes in its own fenced block
  tagged with where it runs (`powershell-admin`, `powershell`, `wsl`, `fish` on perigee, `bash`, `cmd`), one shell per block.**
- Styles come only through `markdownElement`/`updateMarkdown`; `renderMarkdown` alone is a string,
  for tests and servers. Preact: `updateMarkdown(ref.current, text, opts)` in a `useEffect`, with
  nothing rendered into that element.
- `linkify(text)` is for text that isn't markdown (a field, a note, a log line): it escapes it and
  links the same URLs, DOIs and web addresses. `linkifyHtml(html)` does that to HTML you built, leaving its tags,
  links and code alone.
