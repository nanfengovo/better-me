/** UTF-16 offsets match textarea selections and DOM Range text offsets. */
export type WritingQuote = { exact: string; prefix: string; suffix: string; start: number; end: number };

export function quoteWritingText(text: string, start: number, end: number): WritingQuote | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || !text.slice(start, end).trim()) return;
  return { exact: text.slice(start, end), prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32), start, end };
}

/** Never fuzzy-match a changed fact. Repeated quotes require unambiguous context. */
export function resolveWritingQuote(text: string, quote: WritingQuote): WritingQuote | undefined {
  if (!quote.exact) return;
  const positions: number[] = [];
  for (let at = text.indexOf(quote.exact); at >= 0; at = text.indexOf(quote.exact, at + 1)) positions.push(at);
  if (positions.length === 1) return quoteWritingText(text, positions[0]!, positions[0]! + quote.exact.length);
  const contextual = positions.filter(at => (!quote.prefix || text.slice(0, at).endsWith(quote.prefix))
    && (!quote.suffix || text.slice(at + quote.exact.length).startsWith(quote.suffix)));
  if (contextual.length !== 1 || (!quote.prefix && !quote.suffix)) return;
  return quoteWritingText(text, contextual[0]!, contextual[0]! + quote.exact.length);
}

/** Text can be split into styled spans. Walk text nodes rather than child indexes. */
export function writingTextRange(element: HTMLElement, start: number, end: number): Range | undefined {
  if (start < 0 || end <= start || end > (element.textContent?.length ?? 0)) return;
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
  const range = element.ownerDocument.createRange();
  let offset = 0, started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) { range.setStart(node, start - offset); started = true; }
    if (started && end <= offset + length) { range.setEnd(node, end - offset); return range; }
    offset += length;
  }
}
