import { needsRichStorage } from "./richMarkdown";
/**
 * mm/md.ts
 * Detection/conversion helpers for the Markdown rendering pass.
 * Nodes containing Freeplane's "\latex" marker or an Obsidian embed are
 * rendered through MarkdownRenderer. Lightweight emphasis and ordinary
 * wikilinks are rendered directly as wrapped SVG tspans.
 */

/** True when the node text needs the Markdown/MathJax rendering pass. */
export function needsMarkdown(text: string): boolean {
  return needsRichStorage(text || "") || /\\latex|!\[\[|\$[^$]+\$|\]\(#fp-node:/.test(text || "");
}

/** Hide Freeplane's rendering marker; existing $/$$ delimiters set math mode. */
export function toMarkdown(text: string): string {
  return (text || "").replace(/^\\latex\s*/, "");
}

export function wikiLabel(target: string): string {
  const parts = target.split("|");
  return parts.length > 1 ? parts.slice(1).join("|") : (target.split("/").pop() || target);
}
