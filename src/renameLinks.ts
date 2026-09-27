import { App, TFile } from "obsidian";

/** Preserve aliases and subpaths; only replace links resolving to the renamed file. */
export function renamedLinks(app: App, xml: string, source: string, oldPath: string, file: TFile): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (doc.querySelector("parsererror")) return xml;
  let changed = false;
  const normalize = (path: string) => {
    const parts: string[] = [];
    for (const p of path.split("/")) { if (p === "..") parts.pop(); else if (p && p !== ".") parts.push(p); }
    return parts.join("/");
  };
  const replace = (text: string) => text.replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
    const split = inner.search(/[|#]/), path = split < 0 ? inner : inner.slice(0, split);
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch {}
    const resolved = app.metadataCache.getFirstLinkpathDest(decoded, source);
    if (resolved && resolved !== file) return whole;
    const relative = normalize(source.slice(0, source.lastIndexOf("/") + 1) + decoded);
    const candidates = [oldPath, oldPath.split("/").pop()!];
    if (oldPath.endsWith(".md")) candidates.push(oldPath.slice(0, -3), oldPath.split("/").pop()!.slice(0, -3));
    if (!candidates.includes(decoded) && relative !== oldPath && relative + ".md" !== oldPath) return whole;
    changed = true;
    return "[[" + app.metadataCache.fileToLinktext(file, source, !decoded.toLowerCase().endsWith(".md")) + (split < 0 ? "" : inner.slice(split)) + "]]";
  });
  for (const el of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) { const value = replace(attr.value); if (value !== attr.value) el.setAttribute(attr.name, value); }
    for (const child of Array.from(el.childNodes)) if (child.nodeType === 3 || child.nodeType === 4) child.nodeValue = replace(child.nodeValue || "");
  }
  return changed ? new XMLSerializer().serializeToString(doc) : xml;
}
