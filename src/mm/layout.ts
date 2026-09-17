/**
 * mm/layout.ts
 * Semantic Freeplane-style tree layout: no coordinates are stored in the
 * file, everything is computed here. The root sits at (0,0); top-level
 * branches go left/right by POSITION (balanced when missing); each subtree
 * is stacked vertically around its parent's center.
 * Also computes node sizes: wrapped multiline TEXT, DETAILS/NOTE preview
 * blocks, and cached Markdown-measured sizes.
 */
import { childNodeElements, richContentPreviewSource } from "./xml";
import { needsMarkdown } from "./md";
import { settings } from "../settings";

const NODE_H = 30;              // single-line title height
const H_GAP = 56;               // horizontal gap parent <-> child
const V_GAP = 10;               // vertical gap between siblings
const RICH_FONT = 12;           // preview font (10% smaller than title)
const RICH_LINE_H = 15;         // preview line height
const RICH_MAX_CHARS = 60;      // preview wrap width in characters
const RICH_PAD_TOP = 8;         // preview top padding
const RICH_PAD_BOTTOM = 8;      // preview bottom padding

/**
 * Build the layout tree for the whole map.
 * `richExpandedIds`: nodes whose DETAILS/NOTE preview is visible.
 * `mdSizes`: cached measured sizes of Markdown-rendered nodes.
 * Returns nodes/edges for the renderer, an id index, tight content bounds
 * and a viewBox padded with a large pannable margin.
 */
export function layoutMap(
  doc: Document,
  richExpandedIds?: Set<string>,
  mdSizes?: Record<string, { w: number; h: number }>,
  imageSizes?: Record<string, { w: number; h: number }>
) {
  const expanded = richExpandedIds || new Set<string>();
  const MAXSYM = settings.nodeMaxWidthSymbols;   // wrap width from settings.json    // visible previews
  const rootEl = childNodeElements(doc.documentElement)[0]; // the map root node

  const nodes: any[] = [];          // flat list for renderer & hit tests
  const edges: any[] = [];          // parent->child connectors
  const byId: Record<string, any> = {};                     // id -> layout node

  if (!rootEl) {                    // empty map: dummy empty layout
    return {
      nodes,
      edges,
      byId,
      rootId: null,
      viewBox: [0, 0, 800, 600],
      bounds: [0, 0, 800, 600],
      width: 800,
      height: 600
    };
  }

  /** Recursively build one layout node (sizes now, positions later). */
  function build(el: Element, depth: number, side: string, includeChildren = true): any {
    const actualChildren = childNodeElements(el);           // real <node> kids
    const folded = el.getAttribute("FOLDED") === "true";    // collapsed?
    const visibleChildren = includeChildren && !folded ? actualChildren : [];

    const id = el.getAttribute("ID") || "";
    const text = el.getAttribute("TEXT") || "";
    const fontEl = Array.from(el.children).find((c) => c.nodeName.toLowerCase() === "font");
    const fontBold = fontEl?.getAttribute("BOLD") === "true";
    const fontItalic = fontEl?.getAttribute("ITALIC") === "true";
    const imageHook = Array.from(el.children).find((c) =>
      c.nodeName.toLowerCase() === "hook" && c.getAttribute("NAME") === "ExternalObject"
    );
    const imageUri = imageHook?.getAttribute("URI") || "";
    const imageScale = Math.max(0.05, Number(imageHook?.getAttribute("SIZE")) || 1);
    const imageSize = imageUri ? (imageSizes || {})[id] || { w: 240, h: 160 } : null;

    const details = richContentPreviewSource(el, "DETAILS").trim(); // preview sources
    const note = richContentPreviewSource(el, "NOTE").trim();
    const hasRich = !!details || !!note;
    const richExpanded = hasRich && expanded.has(id);        // preview visible?

    const richBlocks: any[] = [];   // wrapped preview paragraphs
    if (richExpanded) {
      if (details) {
        richBlocks.push({
          type: "DETAILS",
          title: "DETAILS",
          lines: wrapText(details, MAXSYM)
        });
      }
      if (note) {
        richBlocks.push({
          type: "NOTE",
          title: "NOTE",
          lines: wrapText(note, MAXSYM)
        });
      }
    }

    for (const block of richBlocks) {
      block.fontSize = block.type === "DETAILS" ? settings.detailsFontSize : RICH_FONT;
      block.lineH = Math.ceil(block.fontSize * 1.35);
      const source = block.type === "DETAILS" ? details : note;
      if (needsMarkdown(source)) {
        block.markdown = source;
        block.size = mdSizes[`${id}:${block.type}`] || { w: 240, h: 60 };
      }
    }
    // +1 line per block reserved for its separator
    const richLineCount = richBlocks.reduce(
      (sum, block) => sum + block.lineH + (block.markdown ? Math.ceil(block.size.h / block.lineH) * block.lineH : block.lines.length * block.lineH),
      0
    );
    const richHeight = richExpanded && richLineCount > 0
      ? RICH_PAD_TOP + richLineCount + RICH_PAD_BOTTOM
      : 0;

    // Preserve lightweight markup on each wrapped line; the renderer turns it
    // into SVG tspans after layout.
    const textLines = wrapText(text, MAXSYM);
    const longestLine = textLines.map(stripInlineMarkdown).reduce(
      (a, b) => (a.length >= b.length ? a : b), " "
    );

    const isMarkdown = needsMarkdown(text);                  // markdown pass?
    const wrapMarkdown = isMarkdown && !/\\latex|!\[\[/.test(text);
    const mdSize = isMarkdown ? (mdSizes || {})[id] || null : null; // measured?
    const textHeight = isMarkdown
      ? Math.max(NODE_H, mdSize ? mdSize.h : 48)             // measured height
      : 14 + textLines.length * 16;                          // 16px per line
    const imageHeight = imageSize ? imageSize.h * imageScale + 12 : 0;
    const titleHeight = textHeight + imageHeight;
    const nodeHeight = titleHeight + richHeight;
    const titleWidth = isMarkdown
      ? (wrapMarkdown ? estimateWidth(longestLine) : (mdSize ? mdSize.w : 220))
      : estimateWidth(longestLine);                          // canvas-measured
    const richLongest = richBlocks.flatMap((b) => b.lines).map(stripInlineMarkdown).reduce(
      (a: string, b: string) => (a.length >= b.length ? a : b), ""
    );
    const richWidth = richExpanded ? Math.max(0, ...richBlocks.map(b => b.size?.w || Math.max(...b.lines.map((line: string) => estimateWidth(stripInlineMarkdown(line)) * b.fontSize / 13)))) : 0;
    const imageWidth = imageSize ? imageSize.w * imageScale + 20 : 0;
    const width = Math.max(titleWidth, richWidth, imageWidth, 60);

    const children = visibleChildren.map((child) =>
      build(child, depth + 1, side, true)
    );
    const childrenHeight =
      children.reduce((sum, child) => sum + child.subtreeH, 0) +
      Math.max(0, children.length - 1) * V_GAP;
    const subtreeH = Math.max(nodeHeight, childrenHeight);   // vertical footprint

    const node = {
      el,
      id,
      text,
      fontBold,
      fontItalic,
      depth,
      side,
      width,
      height: nodeHeight,
      titleHeight,
      textHeight,
      isMarkdown,
      wrapMarkdown,
      lines: textLines,
      richBlocks,
      hasRich,
      hasDetails: !!details,
      hasNote: !!note,
      richExpanded,
      richFont: RICH_FONT,
      richLineH: RICH_LINE_H,
      imageUri,
      imageScale,
      imageSize,
      x: 0,
      y: 0,
      children,
      subtreeH,
      folded,
      hasChildren: actualChildren.length > 0
    };
    byId[node.id] = node;
    return node;
  }

  const root = build(rootEl, 0, "right", false);  // root built without kids
  root.x = -root.width / 2;                       // center root at origin
  root.y = -root.height / 2;

  // split top-level branches by POSITION (balance sides when missing)
  const topEls = root.folded ? [] : childNodeElements(rootEl);
  const rightEls: Element[] = [];
  const leftEls: Element[] = [];
  topEls.forEach((el) => {
    const pos = el.getAttribute("POSITION");
    if (pos === "left") {
      leftEls.push(el);
    } else if (pos === "right") {
      rightEls.push(el);
    } else {
      if (rightEls.length <= leftEls.length) rightEls.push(el); // keep balanced
      else leftEls.push(el);
    }
  });

  const rightNodes = rightEls.map((el) => build(el, 1, "right", true));
  const leftNodes = leftEls.map((el) => build(el, 1, "left", true));
  root.children = [...rightNodes, ...leftNodes];

  placeSide(root, rightNodes, "right");
  placeSide(root, leftNodes, "left");

  /** Stack one side's subtrees vertically, centered on the root. */
  function placeSide(rootNode: any, list: any[], side: string) {
    if (list.length === 0) return;
    const total =
      list.reduce((sum, n) => sum + n.subtreeH, 0) +
      Math.max(0, list.length - 1) * V_GAP;
    let y = -total / 2;                            // start above the center
    for (const node of list) {
      const centerY = y + node.subtreeH / 2;       // this subtree's center
      const anchorX =
        side === "right"
          ? rootNode.x + rootNode.width + H_GAP    // right of parent
          : rootNode.x - H_GAP;                    // left of parent
      place(node, anchorX, centerY, side);
      y += node.subtreeH + V_GAP;                  // advance down
    }
  }

  /** Position one node; recurse into children stacked around its center. */
  function place(node: any, anchorX: number, centerY: number, side: string) {
    node.side = side;
    if (side === "right") node.x = anchorX;        // anchor = left edge
    else node.x = anchorX - node.width;            // anchor = right edge
    node.y = centerY - node.height / 2;
    if (node.children.length === 0) return;
    const total =
      node.children.reduce((sum: number, child: any) => sum + child.subtreeH, 0) +
      Math.max(0, node.children.length - 1) * V_GAP;
    let y = centerY - total / 2;
    for (const child of node.children) {
      const childCenterY = y + child.subtreeH / 2;
      const nextAnchorX =
        side === "right"
          ? node.x + node.width + H_GAP
          : node.x - H_GAP;
      place(child, nextAnchorX, childCenterY, side);
      y += child.subtreeH + V_GAP;
    }
  }

  /** Flatten tree into nodes[] and edges[] for the renderer. */
  function collect(node: any) {
    nodes.push(node);
    for (const child of node.children) {
      edges.push({ from: node, to: child });
      collect(child);
    }
  }
  collect(root);

  // tight bounds of all nodes (±26 leaves room for the side circles)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x - 26);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width + 26);
    maxY = Math.max(maxY, n.y + n.height);
  }
  if (!isFinite(minX)) {                           // no nodes at all
    minX = 0;
    minY = 0;
    maxX = 800;
    maxY = 600;
  }

  const bounds = [minX, minY, maxX, maxY];         // used by fit/center
  // large empty margin so any node can be panned anywhere on screen
  const pad = 2000;
  const viewBox = [
    minX - pad,
    minY - pad,
    maxX - minX + pad * 2,
    maxY - minY + pad * 2
  ];

  return {
    nodes,
    edges,
    byId,
    rootId: root.id,
    viewBox,
    bounds,
    width: Math.max(800, viewBox[2]),
    height: Math.max(600, viewBox[3])
  };
}

/** Remove lightweight emphasis markers when estimating visible width. */
function stripInlineMarkdown(text: string): string {
  return String(text).replace(/\*\*\*([^*]+)\*\*\*/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1");
}

let measureCtx: CanvasRenderingContext2D | null = null;  // lazy canvas measurer
let cachedFont = "";                                     // cached font string

/** Cached "13px <theme font family>" string for canvas measurement. */
function font13(): string {
  if (!cachedFont) {
    const fam =
      (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) ||
      "sans-serif";
    cachedFont = "13px " + fam;
  }
  return cachedFont;
}

/** Measure real rendered text width; add 10px padding on each side. */
function estimateWidth(text: string): number {
  const t = text || " ";
  let w: number;
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (measureCtx) {
    measureCtx.font = font13();                  // same font as SVG text
    w = measureCtx.measureText(t).width;         // exact pixel width
  } else {
    w = t.length * 7;                            // fallback estimate
  }
  // 10px left padding (text x=10) + 10px right padding
  return Math.max(60, Math.ceil(w) + 20);
}

/** Word-wrap preview Markdown without cutting bold/italic markers in half. */
function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const originalLine of String(text).replace(/\r\n/g, "\n").split("\n")) {
    if (!originalLine) { out.push(""); continue; }
    const pattern = /(!?\[\[[^\]\n]*\]\]|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
    const parts = originalLine.split(pattern).filter(Boolean);
    let line = "", visible = 0, pendingSpace = false;
    const flush = () => { if (line) out.push(line); line = ""; visible = 0; pendingSpace = false; };
    const append = (word: string, prefix = "", suffix = "", atomic = false) => {
      if (!word) return;
      if (atomic) {
        const sep = pendingSpace && visible ? " " : "";
        if (visible && visible + sep.length + word.length > width) flush();
        line += (pendingSpace && visible ? " " : "") + prefix + word + suffix;
        visible += (pendingSpace && visible ? 1 : 0) + word.length;
        pendingSpace = false;
        return;
      }
      let rest = word;
      while (rest) {
        const sep = pendingSpace && visible ? 1 : 0;
        const room = width - visible - sep;
        if (visible && room <= 0) { flush(); continue; }
        if (visible && rest.length <= width && rest.length > room) { flush(); continue; }
        const take = Math.min(rest.length, Math.max(1, room));
        const piece = rest.slice(0, take);
        line += (pendingSpace && visible ? " " : "") + prefix + piece + suffix;
        visible += (pendingSpace && visible ? 1 : 0) + piece.length;
        pendingSpace = false;
        rest = rest.slice(take);
        if (rest) flush();
      }
    };
    for (const part of parts) {
      const link = /^(!?\[\[)([^\]\n]*)(\]\])$/.exec(part);
      const both = /^(\*\*\*)([^*\n]+)(\*\*\*)$/.exec(part);
      const bold = /^(\*\*|__)([^*_\n]+)(\*\*|__)$/.exec(part);
      const italic = /^(\*|_)([^*_\n]+)(\*|_)$/.exec(part);
      const match = both || bold || italic;
      if (link) { append(link[2], link[1], link[3], true); continue; }
      const source = match ? match[2] : part;
      const prefix = match ? match[1] : "", suffix = match ? match[3] : "";
      for (const token of source.split(/(\s+)/)) {
        if (!token) continue;
        if (/^\s+$/.test(token)) pendingSpace = true;
        else append(token, prefix, suffix);
      }
    }
    flush();
  }
  return out;
}
