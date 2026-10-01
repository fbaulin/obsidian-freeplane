import { characterLimitPixels, inlinePixels, wrapPixels } from "./textMetrics";
import { nodeTextSource } from "./xml";
/**
 * mm/layout.ts
 * Semantic Freeplane-style tree layout: no coordinates are stored in the
 * file, everything is computed here. The root sits at (0,0); top-level
 * branches go left/right by POSITION (right when missing); each subtree
 * is stacked vertically around its parent's center.
 * Also computes node sizes: wrapped multiline TEXT, DETAILS/NOTE preview
 * blocks, and cached Markdown-measured sizes.
 */
import { childNodeElements, richContentPreviewSource } from "./xml";
import { needsMarkdown, wikiLabel } from "./md";
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
    const text = nodeTextSource(el) || "";
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
          lines: wrapPixels(details, characterLimitPixels(MAXSYM), settings.detailsFontSize)
        });
      }
      if (note) {
        richBlocks.push({
          type: "NOTE",
          title: "NOTE",
          lines: wrapPixels(note, characterLimitPixels(MAXSYM), RICH_FONT)
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
    const pixelLimit = characterLimitPixels(MAXSYM);
    const textLines = wrapPixels(text, pixelLimit, 13, fontBold, fontItalic);
    const measuredTitleWidth = Math.max(60, ...textLines.map(line => Math.ceil(inlinePixels(line, 13, fontBold, fontItalic)) + 20));

    const isMarkdown = needsMarkdown(text);                  // markdown pass?
    const wrapMarkdown = isMarkdown && !/\\latex|!\[\[/.test(text);
    const mdSize = isMarkdown ? (mdSizes || {})[id] || null : null; // measured?
    const textHeight = isMarkdown
      ? Math.max(NODE_H, mdSize ? mdSize.h : 48)             // measured height
      : 14 + textLines.length * 16;                          // 16px per line
    const imageHeight = imageSize ? imageSize.h * imageScale + 12 : 0;
    const titleHeight = textHeight + imageHeight;
    const contentHeight = titleHeight + richHeight;
    const nodeHeight = Math.min(contentHeight, 14 + Math.round(settings.nodeMaxHeightLines) * 16);
    const scrollable = contentHeight > nodeHeight;
    const titleWidth = isMarkdown
      ? (wrapMarkdown ? (mdSize ? mdSize.w : Math.min(pixelLimit + 20, measuredTitleWidth)) : (mdSize ? mdSize.w : 220))
      : measuredTitleWidth;                          // canvas-measured
    const richWidth = richExpanded ? Math.max(0, ...richBlocks.map(b => b.size?.w || Math.max(...b.lines.map((line: string) => Math.ceil(inlinePixels(line, b.fontSize)) + 20)))) : 0;
    const imageWidth = imageSize ? imageSize.w * imageScale + 20 : 0;
    const width = Math.max(titleWidth, richWidth, imageWidth, 60) + (scrollable ? 16 : 0);

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
      contentHeight,
      scrollable,
      titleHeight,
      textHeight,
      isMarkdown,
      wrapMarkdown,
      pixelLimit,
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

  // split top-level branches by POSITION (default to right when missing)
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
      rightEls.push(el);
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

