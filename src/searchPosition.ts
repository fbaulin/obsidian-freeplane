/** Search match offsets are character offsets, not editor line numbers. */
export function matchingNode(text: string, state: any): string | null {
  const match = state?.match;
  const offset = Array.isArray(match) ? (Array.isArray(match[0]) ? match[0][0] : match[0])
    : typeof match?.start === "number" ? match.start : undefined;
  const line = state?.line ?? state?.start?.line;
  const prefix = typeof offset === "number" ? text.slice(0, offset + 1)
    : typeof line === "number" ? text.split("\n").slice(0, line + 1).join("\n") : "";
  const headings = Array.from(prefix.matchAll(/^## (.+)$/gm));
  return headings.length ? headings[headings.length - 1][1] : null;
}
