export function parseMm(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");

  const parserError =
    doc.getElementsByTagName("parsererror")[0] || doc.querySelector("parsererror");

  if (parserError) {
    throw new Error(parserError.textContent || "Invalid XML");
  }

  const root = doc.documentElement;

  if (!root || root.nodeName.toLowerCase() !== "map") {
    throw new Error("Not a Freeplane .mm file (expected <map> root element)");
  }

  ensureIds(root);
  return doc;
}

export function serializeDoc(doc: Document): string {
  if (!doc.documentElement) return "";
  return new XMLSerializer()
    .serializeToString(doc.documentElement)
    .replace(/&#10;/g, "&#xa;");
}

export function serializeMm(doc: Document, originalText: string): string {
  const declMatch = originalText.match(/^\s*<\?xml[\s\S]*?\?>/);
  const decl = declMatch ? declMatch[0].trim() : "";

  let xml = serializeDoc(doc);

  if (decl && !xml.trimStart().startsWith("<?xml")) {
    xml = decl + "\n" + xml;
  }

  if (!xml.endsWith("\n")) {
    xml += "\n";
  }

  return xml;
}

export function childNodeElements(el: Element): Element[] {
  return Array.from(el.children).filter((c) => c.nodeName.toLowerCase() === "node");
}

export function nodeById(doc: Document, id: string): Element | null {
  if (!id) return null;

  const escaped =
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");

  try {
    return doc.querySelector(`node[ID="${escaped}"]`);
  } catch {
    return null;
  }
}

export function setText(nodeEl: Element, text: string) {
  if (text === "") {
    nodeEl.removeAttribute("TEXT");
  } else {
    nodeEl.setAttribute("TEXT", text);
  }
}

export function toggleFolded(nodeEl: Element): boolean {
  if (childNodeElements(nodeEl).length === 0) return false;

  const folded = nodeEl.getAttribute("FOLDED") === "true";

  if (folded) {
    nodeEl.removeAttribute("FOLDED");
  } else {
    nodeEl.setAttribute("FOLDED", "true");
  }

  return true;
}

export function findRichcontent(nodeEl: Element, type: string): Element | null {
  return (
    Array.from(nodeEl.children).find(
      (child) =>
        child.nodeName.toLowerCase() === "richcontent" &&
        child.getAttribute("TYPE") === type
    ) || null
  );
}

export function richContentSource(nodeEl: Element, type: string): string {
  const rc = findRichcontent(nodeEl, type);
  if (!rc) return "";

  // UX: body with only text-only <p> elements -> show plain lines
  const body = rc.getElementsByTagName("body")[0];
  if (body) {
    const kids = Array.from(body.children);
    if (kids.length > 0 && kids.every((k) => k.nodeName.toLowerCase() === "p" && k.children.length === 0)) {
      return kids.map((k) => (k.textContent || "").trim()).join("\n");
    }
  }

  const serializer = new XMLSerializer();
  return Array.from(rc.childNodes)
    .map((child) => serializer.serializeToString(child))
    .join("");
}

export function setRichContent(
  doc: Document,
  nodeEl: Element,
  type: string,
  source: string
) {
  let rc = findRichcontent(nodeEl, type);
  const trimmed = source.trim();

  if (!trimmed) {
    if (rc) rc.remove();
    return;
  }

  if (!rc) {
    rc = doc.createElement("richcontent");
    rc.setAttribute("TYPE", type);

    // Insert richcontent before child <node> elements where possible.
    const firstNodeChild = childNodeElements(nodeEl)[0];
    if (firstNodeChild) {
      nodeEl.insertBefore(rc, firstNodeChild);
    } else {
      nodeEl.appendChild(rc);
    }
  }

  const parsed = parseRichContentFragment(type, trimmed);

  // fresh content is visible
  rc.removeAttribute("HIDDEN");

  while (rc.firstChild) {
    rc.removeChild(rc.firstChild);
  }

  for (const child of Array.from(parsed.childNodes)) {
    rc.appendChild(doc.importNode(child, true));
  }
}

function parseRichContentFragment(type: string, source: string): Element {
  let xml = source.trim();

  // Convenience: plain text becomes a simple XHTML paragraph.
  if (!xml.startsWith("<")) {
    const paras = xml
      .split("\n")
      .map((line) => `<p>${escapeXml(line)}</p>`)
      .join("");
    xml = `<html><head></head><body>${paras}</body></html>`;
  }

  let fragDoc: Document;

  if (/^<richcontent[\s>]/i.test(xml)) {
    fragDoc = new DOMParser().parseFromString(xml, "application/xml");
  } else {
    fragDoc = new DOMParser().parseFromString(
      `<richcontent TYPE="${escapeXml(type)}">${xml}</richcontent>`,
      "application/xml"
    );
  }

  const parserError =
    fragDoc.getElementsByTagName("parsererror")[0] ||
    fragDoc.querySelector("parsererror");

  if (parserError) {
    throw new Error("Content must be valid XML/XHTML.");
  }

  const root = fragDoc.documentElement;

  if (!root || root.nodeName.toLowerCase() !== "richcontent") {
    throw new Error("Could not parse richcontent fragment.");
  }

  return root;
}

export function moveNode(
  doc: Document,
  dragId: string,
  targetId: string,
  mode: "child" | "before" | "after",
  sideHint?: "left" | "right"
): boolean {
  const drag = nodeById(doc, dragId);
  const target = nodeById(doc, targetId);

  if (!drag || !target || drag === target) return false;

  // Prevent dropping a node into its own descendant.
  if (drag.contains(target)) return false;

  if (mode === "child") {
    target.appendChild(drag);

    if (isRootNode(target)) {
      const side = sideHint || drag.getAttribute("POSITION") || "right";
      drag.setAttribute("POSITION", side === "left" ? "left" : "right");
    } else {
      drag.removeAttribute("POSITION");
    }

    return true;
  }

  const parent = target.parentElement;

  // before/after only applies to siblings inside a parent <node>.
  if (!parent || parent.nodeName.toLowerCase() !== "node") return false;

  let ref: Element | null = target;

  if (mode === "after") {
    ref = nextNodeSibling(target);
  }

  // If the reference is the dragged node itself, move to its next node sibling.
  if (ref === drag) {
    ref = nextNodeSibling(drag);
  }

  parent.insertBefore(drag, ref);

  if (isRootNode(parent)) {
    const side = target.getAttribute("POSITION") || sideHint || "right";
    drag.setAttribute("POSITION", side === "left" ? "left" : "right");
  } else {
    drag.removeAttribute("POSITION");
  }

  return true;
}

function isRootNode(el: Element): boolean {
  return (
    !!el.parentElement &&
    el.parentElement.nodeName.toLowerCase() === "map"
  );
}

function nextNodeSibling(el: Element): Element | null {
  let sibling = el.nextElementSibling;

  while (sibling && sibling.nodeName.toLowerCase() !== "node") {
    sibling = sibling.nextElementSibling;
  }

  return sibling;
}

function ensureIds(root: Element) {
  const existing = new Set<string>();

  root.querySelectorAll("node[ID]").forEach((node) => {
    const id = node.getAttribute("ID");
    if (id) existing.add(id);
  });

  root.querySelectorAll("node").forEach((node) => {
    if (node.getAttribute("ID")) return;

    let id = "";
    do {
      id = "ID_" + Math.random().toString(36).slice(2, 10);
    } while (existing.has(id));

    existing.add(id);
    node.setAttribute("ID", id);
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}