/**
 * A deterministic QR-style pattern, seeded from the target string so it is
 * stable per ledger. This is the design's placeholder visual — for a production
 * scannable code, swap in a real QR encoder that encodes the deeplink. Tracked
 * as an issue rather than a silent stub.
 */
export function qrSvg(seedStr: string): string {
  const n = 25;
  let s = 0;
  for (const ch of seedStr) s = (s * 31 + ch.charCodeAt(0)) % 2147483647;
  const rnd = (): number => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
  const inFinder = (x: number, y: number): boolean =>
    (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
  const cells: string[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (!inFinder(x, y) && rnd() < 0.44) cells.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="#1C1512"/>`);
  const finder = (fx: number, fy: number): string =>
    `<rect x="${fx}" y="${fy}" width="7" height="7" fill="none" stroke="#1C1512" stroke-width="1"/>` +
    `<rect x="${fx + 2}" y="${fy + 2}" width="3" height="3" fill="#1C1512"/>`;
  return `<svg viewBox="0 0 ${n} ${n}" width="100%" height="100%" shape-rendering="crispEdges">${cells.join('')}${finder(0.5, 0.5)}${finder(n - 7.5, 0.5)}${finder(0.5, n - 7.5)}</svg>`;
}
