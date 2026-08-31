export function needsMarkdown(text: string): boolean {
  return /\\latex|\[\[/.test(text || "");
}

export function toMarkdown(text: string): string {
  let t = text || "";
  // Freeplane-style "\latex x = x^2" -> "$x = x^2$"
  if (/^\\latex\s*/.test(t)) {
    t = "$" + t.replace(/^\\latex\s*/, "") + "$";
  }
  return t;
}
