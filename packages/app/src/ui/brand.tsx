const LEFT = 'M7 6h14v6l8 6-8 6 8 6-8 6v6H7z';
const RIGHT = 'M25 6h16v36H25v-6l8-6-8-6 8-6-8-6z';

export function Mark({ size = 24, mono = false, title }: { size?: number; mono?: boolean; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <path fill={mono ? 'currentColor' : 'var(--ink)'} d={LEFT} />
      <path fill={mono ? 'currentColor' : 'var(--action)'} d={RIGHT} />
    </svg>
  );
}

export function Wordmark({ height = 28 }: { height?: number }) {
  return <img src="/brand/tally-wordmark.svg" alt="Tally" height={height} style={{ height, width: 'auto', display: 'block' }} />;
}
