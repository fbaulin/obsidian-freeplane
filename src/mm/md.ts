/**
 * mm/md.ts
 * Detection/conversion helpers for the Markdown rendering pass.
 * Nodes whose TEXT contains Freeplane's "\latex" marker, Markdown emphasis,
 * or Obsidian wikilinks ([[...]] / ![[...]]) are rendered through Obsidian's
 * MarkdownRenderer (MathJax, links, Excalidraw embeds) instead of plain
 * SVG text.
 */

/** True when the node text needs the Markdown/MathJax rendering pass. */
export function needsMarkdown(text: string): boolean {
  return /\\latex|\[\[|\*\*|__|(^|[\s(])[*_][^*_\n]+[*_]/m.test(text || "");
}

/** Hide Freeplane's rendering marker; existing $/$$ delimiters set math mode. */
export function toMarkdown(text: string): string {
  return (text || "").replace(/^\\latex\s*/, "");
}
