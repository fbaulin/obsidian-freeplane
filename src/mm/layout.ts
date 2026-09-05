import { childNodeElements, richContentSource } from "./xml";
import { needsMarkdown } from "./md";

const NODE_H = 30;
const H_GAP = 56;
const V_GAP = 10;
const RICH_FONT = 12;
const RICH_LINE_H = 15;
const RICH_MAX_CHARS = 60;
const RICH_PAD_TOP = 8;
const RICH_PAD_BOTTOM = 8;

export function layoutMap(doc: Document, richExpandedIds?: Set<string>, mdSizes?: Record<string, { w: number; h: number }>) {
  const expanded = richExpandedIds || new Set<string>();
  const rootEl = childNodeElements(doc.documentElement)[0];

  const nodes: any[] = [];
  const edges: any[] = [];
  const byId: Record<string, any> = {};

  if (!rootEl) {
    return {
      nodes,
      edges,
      byId,
      rootId: null,
      viewBox: [0, 0, 800, 600],
      width: 800,
      height: 600
    };
  }

  function build(el: Element, depth: number, side: string, includeChildren = true): any {
    const actualChildren = childNodeElements(el);
    const folded = el.getAttribute("FOLDED") === "true";
    const visibleChildren = includeChildren && !folded ? actualChildren : [];

    const id = el.getAttribute("ID") || "";
    const text = el.getAttribute("TEXT") || "";

    const details = richContentSource(el, "DETAILS").trim();
    const note = richContentSource(el, "NOTE").trim();
    const hasRich = !!details || !!note;
    const richExpanded = hasRich && expanded.has(id);

    const richBlocks: any[] = [];

    if (richExpanded) {
      if (details) {
        richBlocks.push({
          type: "DETAILS",
          title: "DETAILS",
          lines: wrapText(details, RICH_MAX_CHARS)
        });
      }

      if (note) {
        richBlocks.push({
          type: "NOTE",
          title: "NOTE",
          lines: wrapText(note, RICH_MAX_CHARS)
        });
      }
    }

    const richLineCount = richBlocks.reduce(
      (sum, block) => sum + 1 + block.lines.length,
      0
    );

    const richHeight = richExpanded && richLineCount > 0
      ? RICH_PAD_TOP + richLineCount * RICH_LINE_H + RICH_PAD_BOTTOM
      : 0;

    const rawLines = text.split("\n");
    const textLines: string[] = [];
    for (const ln of rawLines) {
      if (ln.length <= 60) {
        textLines.push(ln);
        continue;
      }
      // word-wrap long lines at 60 chars, same as the inline editor
      let rest = ln;
      while (rest.length > 60) {
        let cut = rest.lastIndexOf(" ", 60);
        if (cut < 12) cut = 60;
        textLines.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      textLines.push(rest);
    }
    const longestLine = textLines.reduce((a, b) => (a.length >= b.length ? a : b), " ");

    const isMarkdown = needsMarkdown(text);
    const mdSize = isMarkdown ? (mdSizes || {})[id] || null : null;
    const titleHeight = isMarkdown
      ? Math.max(NODE_H, mdSize ? mdSize.h : 48)
      : 14 + textLines.length * 16;

    const nodeHeight = titleHeight + richHeight;

    const titleWidth = isMarkdown
      ? (mdSize ? mdSize.w : 220)
      : estimateWidth(longestLine);
    const richWidth = richExpanded ? RICH_MAX_CHARS * 6.4 + 34 : 0;
    const width = Math.max(titleWidth, richWidth, 60);

    const children = visibleChildren.map((child) =>
      build(child, depth + 1, side, true)
    );

    const childrenHeight =
      children.reduce((sum, child) => sum + child.subtreeH, 0) +
      Math.max(0, children.length - 1) * V_GAP;

    const subtreeH = Math.max(nodeHeight, childrenHeight);

    const node = {
      el,
      id,
      text,
      depth,
      side,
      width,
      height: nodeHeight,
      titleHeight,
      isMarkdown,
      lines: textLines,
      richBlocks,
      hasRich,
      hasDetails: !!details,
      hasNote: !!note,
      richExpanded,
      richFont: RICH_FONT,
      richLineH: RICH_LINE_H,
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

  const root = build(rootEl, 0, "right", false);

  root.x = -root.width / 2;
  root.y = -root.height / 2;

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
      if (rightEls.length <= leftEls.length) rightEls.push(el);
      else leftEls.push(el);
    }
  });

  const rightNodes = rightEls.map((el) => build(el, 1, "right", true));
  const leftNodes = leftEls.map((el) => build(el, 1, "left", true));

  root.children = [...rightNodes, ...leftNodes];

  placeSide(root, rightNodes, "right");
  placeSide(root, leftNodes, "left");

  function placeSide(rootNode: any, list: any[], side: string) {
    if (list.length === 0) return;

    const total =
      list.reduce((sum, n) => sum + n.subtreeH, 0) +
      Math.max(0, list.length - 1) * V_GAP;

    let y = -total / 2;

    for (const node of list) {
      const centerY = y + node.subtreeH / 2;
      const anchorX =
        side === "right"
          ? rootNode.x + rootNode.width + H_GAP
          : rootNode.x - H_GAP;

      place(node, anchorX, centerY, side);

      y += node.subtreeH + V_GAP;
    }
  }

  function place(node: any, anchorX: number, centerY: number, side: string) {
    node.side = side;

    if (side === "right") node.x = anchorX;
    else node.x = anchorX - node.width;

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

  function collect(node: any) {
    nodes.push(node);

    for (const child of node.children) {
      edges.push({ from: node, to: child });
      collect(child);
    }
  }

  collect(root);

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

  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 800;
    maxY = 600;
  }

  const pad = 80;
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
    width: Math.max(800, viewBox[2]),
    height: Math.max(600, viewBox[3])
  };
}

let measureCtx: CanvasRenderingContext2D | null = null;
let cachedFont = "";

function font13(): string {
  if (!cachedFont) {
    const fam =
      (typeof document !== "undefined" && getComputedStyle(document.body).fontFamily) ||
      "sans-serif";
    cachedFont = "13px " + fam;
  }
  return cachedFont;
}

function estimateWidth(text: string): number {
  const t = text || " ";
  let w: number;
  if (!measureCtx) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (measureCtx) {
    measureCtx.font = font13();
    w = measureCtx.measureText(t).width;
  } else {
    w = t.length * 7;
  }
  // 10px left padding (text x=10) + 10px right padding
  return Math.max(60, Math.ceil(w) + 20);
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];

  for (const originalLine of String(text).replace(/\r\n/g, "\n").split("\n")) {
    let line = originalLine;

    if (line.length === 0) {
      out.push("");
      continue;
    }

    while (line.length > width) {
      let cut = line.lastIndexOf(" ", width);
      if (cut < 12) cut = width;
      out.push(line.slice(0, cut));
      line = line.slice(cut).trimStart();
    }

    out.push(line);
  }

  return out;
}
