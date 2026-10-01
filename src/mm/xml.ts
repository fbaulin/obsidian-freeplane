import { markdownHtml, needsRichStorage, htmlMarkdown } from "./richMarkdown";
/**
 * mm/xml.ts
 * XML safety layer. Parses `.mm` files (repairing HTML named entities that
 * are invalid in strict XML), serializes them back preserving the original
 * XML declaration and Freeplane's `&#xa;` newline spelling, and provides the
 * small DOM helpers used by the view: node lookup, TEXT/FOLDED edits,
 * richcontent read/write and structural node moves.
 * Everything is DOM mutation + XMLSerializer — never full regeneration.
 */

const XML_ENTS = ["amp", "lt", "gt", "apos", "quot"];  // legal XML entities
let entDecoder: HTMLTextAreaElement | null = null;     // lazy entity decoder

/**
 * Freeplane files may contain HTML entities (&nbsp; etc.) which strict XML
 * rejects. Rewrite every known HTML named entity to its numeric form
 * (&nbsp; -> &#160;); unknown names are left untouched.
 */
function htmlEntityToNumeric(text: string): string {
  return text.replace(/&([a-zA-Z][a-zA-Z0-9]{1,30});/g, (m, name) => {
    if (XML_ENTS.indexOf(name) >= 0) return m;          // keep XML entities
    if (!entDecoder) entDecoder = document.createElement("textarea");
    entDecoder.innerHTML = "&" + name + ";";            // browser decodes it
    const v = entDecoder.value;
    if (!v || v === "&" + name + ";") return m;         // truly unknown: keep
    return "&#" + v.codePointAt(0) + ";";               // numeric equivalent
  });
}

/**
 * Parse `.mm` text into a Document. Throws on parser errors or a non-`<map>`
 * root. Guarantees every `<node>` has an ID (generates one only if missing).
 */
export function parseMm(text: string): Document {
  const doc = new DOMParser().parseFromString(htmlEntityToNumeric(text), "application/xml");

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

/** Serialize the map element; newlines in attributes become `&#xa;` (Freeplane style). */
export function serializeDoc(doc: Document): string {
  if (!doc.documentElement) return "";
  return new XMLSerializer()
    .serializeToString(doc.documentElement)
    .replace(/&#10;/g, "&#xa;");
}

/**
 * Full-file serialization: re-attaches the original `<?xml ...?>`
 * declaration (if the source had one) and a trailing newline.
 */
export function serializeMm(doc: Document, originalText: string): string {
  const declMatch = originalText.match(/^\s*<\?xml[\s\S]*?\?>/);  // original prolog
  const decl = declMatch ? declMatch[0].trim() : "";

  let xml = serializeDoc(doc);

  if (decl && !xml.trimStart().startsWith("<?xml")) {
    xml = decl + "\n" + xml;                              // re-attach once
  }
  if (!xml.endsWith("\n")) xml += "\n";                   // Freeplane ends with \n
  return xml;
}

/** Serialize complete node subtrees for application/x-freeplane-node+xml. */
export function serializeNodeClipboard(nodes: Element[]): string {
  const serializer = new XMLSerializer();
  return nodes.map((node) => serializer.serializeToString(node).replace(/&#10;/g, "&#xa;")).join("\n");
}

/** Parse one or more raw <node> fragments (or a full <map>) from a clipboard. */
export function parseNodeClipboard(text: string): Element[] {
  const source = htmlEntityToNumeric(String(text).replace(/^\s*<\?xml[\s\S]*?\?>\s*/, ""));
  const doc = new DOMParser().parseFromString("<clipboard>" + source + "</clipboard>", "application/xml");
  const parserError = doc.getElementsByTagName("parsererror")[0] || doc.querySelector("parsererror");
  if (parserError) throw new Error(parserError.textContent || "Invalid clipboard XML");
  const direct = Array.from(doc.documentElement.children);
  const nodes = direct.filter((el) => el.nodeName.toLowerCase() === "node");
  if (nodes.length) return nodes;
  const map = direct.find((el) => el.nodeName.toLowerCase() === "map");
  return map ? childNodeElements(map) : [];
}

/** Direct `<node>` children of an element (ignores richcontent, font, ...). */
export function childNodeElements(el: Element): Element[] {
  return Array.from(el.children).filter(
    (c) => c.nodeName.toLowerCase() === "node"
  );
}

/** Find a node element by its Freeplane ID attribute (CSS-escaped). */
export function nodeById(doc: Document, id: string): Element | null {
  if (!id) return null;

  const escaped =
    typeof CSS !== "undefined" && CSS.escape
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");

  try {
    return doc.querySelector(`node[ID="${escaped}"]`);
  } catch {
    return null;                                          // bad selector safety
  }
}

/** Set node TEXT; empty string removes the attribute (Freeplane tolerates it). */
export function setText(nodeEl: Element, text: string) {
  if (needsRichStorage(text)) {
    setRichContent(nodeEl.ownerDocument, nodeEl, "NODE", text);
    nodeEl.removeAttribute("TEXT");
    return;
  }
  findRichcontent(nodeEl, "NODE")?.remove();
  if (text === "") {
    nodeEl.removeAttribute("TEXT");
  } else {
    nodeEl.setAttribute("TEXT", text);
  }
}

export function nodeTextSource(node: Element): string {
  return findRichcontent(node, "NODE") ? richContentSource(node, "NODE") : node.getAttribute("TEXT") || "";
}

/** Toggle FOLDED="true" (unfold removes the attribute). False if no children. */
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

/** Direct richcontent child of given TYPE (DETAILS/NOTE), or null. */
export function findRichcontent(nodeEl: Element, type: string): Element | null {
  return (
    Array.from(nodeEl.children).find(
      (child) =>
        child.nodeName.toLowerCase() === "richcontent" &&
        child.getAttribute("TYPE") === type
    ) || null
  );
}

/**
 * Read richcontent for editing. UX: if the XHTML body holds only text-only
 * `<p>` elements, return their plain text joined by newlines; otherwise the
 * raw inner XML so structure is never lost.
 */
export function richContentSource(nodeEl: Element, type: string): string {
  const rc = findRichcontent(nodeEl, type);
  if (!rc) return "";

  // UX: body with only text-only <p> elements -> show plain lines
  const body = rc.getElementsByTagName("body")[0];
  if (body && !body.querySelector("[rowspan], [colspan]") && Array.from(body.querySelectorAll("*")).every(el => /^(p|div|br|pre|code|table|thead|tbody|tfoot|tr|th|td|b|strong|i|em|s|strike|del)$/i.test(el.tagName))) {
    return htmlMarkdown(body);
  }
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

/** Plain preview text with XHTML bold/italic converted to Markdown markers. */
export function richContentPreviewSource(nodeEl: Element, type: string): string {
  const rc = findRichcontent(nodeEl, type);
  if (!rc) return "";
  const body = rc.getElementsByTagName("body")[0] || rc;
  return htmlMarkdown(body);
}

/**
 * Write richcontent. Empty source removes the element. Plain text is wrapped
 * into one XHTML `<p>` per line; markup sources must be valid XML/XHTML.
 * Fresh content clears HIDDEN so the preview shows it. Element attributes
 * (e.g. CONTENT-TYPE) are preserved because we only replace children.
 */
export function setRichContent(
  doc: Document,
  nodeEl: Element,
  type: string,
  source: string
) {
  let rc = findRichcontent(nodeEl, type);
  const trimmed = source.trim();

  if (!trimmed) {
    if (rc) rc.remove();                                  // cleared -> drop element
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
    rc.removeChild(rc.firstChild);                        // wipe old children
  }

  for (const child of Array.from(parsed.childNodes)) {
    rc.appendChild(doc.importNode(child, true));          // import parsed XHTML
  }
}

/**
 * Parse user-supplied richcontent source. Plain text becomes XHTML
 * paragraphs; a full `<richcontent>` wrapper is accepted; anything else is
 * wrapped in one. Throws when the result is not valid XML.
 */
function parseRichContentFragment(type: string, source: string): Element {
  let xml = source.trim();

  // Convenience: plain text becomes a simple XHTML paragraph per line.
  if (!xml.startsWith("<")) {
    xml = markdownHtml(xml);
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

/**
 * Structural move used by drag & drop and hotkeys.
 * mode "child": append into target; "before"/"after": sibling reorder.
 * Keeps/sets POSITION only for top-level nodes; never touches descendants'
 * contents. Returns false for illegal targets (self, own descendant, root).
 */
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
      drag.removeAttribute("POSITION");                   // POSITION = top-level only
    }

    return true;
  }

  const parent = target.parentElement;

  // before/after only applies to siblings inside a parent <node>.
  if (!parent || parent.nodeName.toLowerCase() !== "node") return false;

  let ref: Element | null = target;

  if (mode === "after") {
    ref = nextNodeSibling(target);                        // insert after target
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

/** True when the element's parent is `<map>` (i.e. it is the root node). */
function isRootNode(el: Element): boolean {
  return (
    !!el.parentElement &&
    el.parentElement.nodeName.toLowerCase() === "map"
  );
}

/** Next sibling that is a `<node>` (skips richcontent/font/etc). */
function nextNodeSibling(el: Element): Element | null {
  let sibling = el.nextElementSibling;

  while (sibling && sibling.nodeName.toLowerCase() !== "node") {
    sibling = sibling.nextElementSibling;
  }

  return sibling;
}

/** Give every `<node>` without an ID a unique Freeplane-style ID_… . */
function ensureIds(root: Element) {
  const existing = new Set<string>();

  root.querySelectorAll("node[ID]").forEach((node) => {
    const id = node.getAttribute("ID");
    if (id) existing.add(id);                             // collect used ids
  });

  root.querySelectorAll("node").forEach((node) => {
    if (node.getAttribute("ID")) return;                  // already identified

    let id = "";
    do {
      id = "ID_" + Math.random().toString(36).slice(2, 10);
    } while (existing.has(id));                           // avoid collisions

    existing.add(id);
    node.setAttribute("ID", id);
  });
}

/** Escape the five XML special characters (for generated markup). */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Descendants inherit the root branch side; missing POSITION always means right. */
export function branchSide(node: Element): "left" | "right" {
  let branch = node;
  while (branch.parentElement?.parentElement?.nodeName.toLowerCase() !== "map") {
    if (branch.parentElement?.nodeName.toLowerCase() !== "node") return "right";
    branch = branch.parentElement;
  }
  return branch.getAttribute("POSITION") === "left" ? "left" : "right";
}
