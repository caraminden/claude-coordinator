// Citadel UI: markdown. Types for /apps/_citadel/ui/markdown.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface MarkdownOptions {
  /** Keep single line breaks as typed, as chat does (default false: a document's soft wraps join). */
  breaks?: boolean;
  /** The text is still arriving: hold back a half table row or a header without its separator, a bare list marker; close a half `**`, `` ` `` or `[link`. */
  streaming?: boolean;
  /** The level a `#` is drawn as (default 3, so a reply's headings sit under the page's own; a document passes 1). */
  headingBase?: number;
  /** A link's HTML, given its target unescaped and its text as HTML. Default: http(s) and mailto open a new tab (never `_top`); anything else is an inert span.cui-link. */
  link?: (href: string, html: string) => string;
  /** An image's HTML, given its target unescaped and its alt text escaped. Default: the alt text. */
  image?: (href: string, alt: string, title: string | null) => string;
  /** Runs over the inline HTML outside code and links, e.g. to link bare words. Default: as is. */
  text?: (html: string) => string;
}

/** `src` as HTML. Everything from the text is escaped first; the only tags are the ones it makes (and `<br>`). */
export function renderMarkdown(src: string, opts?: MarkdownOptions): string;

/** GitHub's id for a heading's HTML: lower case, punctuation dropped, spaces to hyphens. Headings carry it as `data-slug`. */
export function slug(html: string): string;

/** A reply as a line or two of HTML for a preview: no links, "• " for list items, a `<br>` between blocks. */
export function markdownLine(src: string, opts?: { streaming?: boolean }): string;

/** A `div.cui-md` drawing `src`, with the markdown styles adopted into the document. */
export function markdownElement(src: string, opts?: MarkdownOptions): HTMLDivElement;

/** Draw `src` into `el` (it becomes `.cui-md`), replacing only the blocks that changed: call it on every streamed chunk. */
export function updateMarkdown(el: Element, src: string, opts?: MarkdownOptions): void;

/** Put `text` on the clipboard; resolves whether it worked. Without a secure context (plain http) it copies a hidden textarea, put beside `near` (default the body: pass an element inside an open modal dialog). Fenced code blocks drawn by markdownElement and updateMarkdown carry a Copy button (`.cui-copy`) that uses it. */
export function copyText(text: string, near?: Element): Promise<boolean>;
