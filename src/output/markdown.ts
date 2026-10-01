/** Markdown helpers for untrusted text (OSM names, model output). */

export function mdEscape(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\\`*_[\]<>|~!&]/g, (c) => `\\${c}`)
    .replace(/www\./gi, (m) => `${m.slice(0, 3)}\u200B.`)
    .replace(/@/g, '@\u200B')
    .replace(/^([#>+-])/, '\\$1')
    .replace(/:\/\//g, ':\u200B//'); // stop auto-linking of untrusted URLs
}

export function hostOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 80);
  }
}

export function pct(part: number, whole: number): string {
  if (whole === 0) return 'n/a';
  return `${part} of ${whole} (${Math.round((part / whole) * 100)}%)`;
}

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
