/**
 * mm/md.ts
 * Detection/conversion helpers for the Markdown rendering pass.
 * Nodes whose TEXT contains Freeplane's "\latex" marker or Obsidian
 * wikilinks ([[...]] / ![[...]]) are rendered through Obsidian's
 * MarkdownRenderer (MathJax, links, Excalidraw embeds) instead of plain
 * SVG text.
 */

/** True when the node text needs the Markdown/MathJax rendering pass. */
export function needsMarkdown(text: string): boolean {
  return /\\latex|\[\[/.test(text || "");   // \latex marker or [[ wikilink
}

/** Convert node TEXT into Markdown source; wraps "\latex …" as "$…$". */
export function toMarkdown(text: string): string {
  let t = text || "";
  // Freeplane-style "\latex x = x^2" -> "$x = x^2$"
  if (/^\\latex\s*/.test(t)) {
    t = "$" + t.replace(/^\\latex\s*/, "") + "$";   // add math delimiters
  }
  return t;
}
