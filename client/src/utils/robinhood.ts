// Robinhood deep-link (Batch X13). Long-press a ticker symbol → open that
// stock on Robinhood in a new tab. See spec/screens/_design-system.md →
// Long-press the ticker symbol → Robinhood.

export function robinhoodUrl(symbol: string): string {
  // Robinhood's stock route is lowercase-keyed; dotted share classes (BRK.B)
  // resolve fine lowercased. encodeURIComponent guards any odd character.
  return `https://robinhood.com/stocks/${encodeURIComponent(symbol.trim().toLowerCase())}/`;
}

// Open in a new tab via a synchronously-clicked anchor. A long-press is not a
// "click", so window.open() is popup-blocked on iOS Safari — a real <a> click
// inside the gesture handler is honored.
export function openRobinhood(symbol: string): void {
  if (!symbol) return;
  const a = document.createElement('a');
  a.href = robinhoodUrl(symbol);
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
