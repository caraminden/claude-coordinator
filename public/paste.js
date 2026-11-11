// What a paste into the composer attaches (#468 S11-5).

/**
 * The files a paste attaches, or none to let the browser paste the text. Word, Excel and LibreOffice put a
 * picture of what was copied beside its text and its HTML: that pastes as the text. A file copied in Finder
 * or Explorer has only its name as text, with no HTML, and a copied image has no text, or HTML that is just
 * the image (a browser's Copy image): those attach.
 */
export function pastedFiles(data) {
  const files = [...(data?.files ?? [])];
  if (!files.length) return files;
  const text = data.getData('text/plain').trim();
  const htmlText = data.getData('text/html').replace(/<[^>]*>/g, '').trim();
  return text && htmlText ? [] : files;
}
