/** Inline Markdown links; destinations may contain balanced parentheses. */
export const markdownLinkPattern = /(?<!!)\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\s]|\([^()]*\))+)(?:\s+"([^"]*)")?\)/g;
export function markdownLink(label: string, target: string): string {
  return '[' + label.replace(/\]/g, '\\]') + '](<' + target.replace(/>/g, '%3E') + '>)';
}
export function wholeMarkdownLink(source: string): { label: string; target: string } | null {
  const matches = Array.from(source.matchAll(markdownLinkPattern));
  const m = matches.length === 1 ? matches[0] : null;
  return m && m[0] === source.trim() ? { label: m[1], target: m[2].replace(/^<|>$/g, '') } : null;
}
