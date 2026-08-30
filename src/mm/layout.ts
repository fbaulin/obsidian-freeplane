import { childNodeElements } from "./xml";

const NODE_H = 30;
const H_GAP = 56;
const V_GAP = 10;

export function layoutMap(doc: Document) {
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

    const text = el.getAttribute("TEXT") || "";
    const width = estimateWidth(text);

    const children = visibleChildren.map((child) =>
      build(child, depth + 1, side, true)
    );

    const childrenHeight =
      children.reduce((sum, child) => sum + child.subtreeH, 0) +
      Math.max(0, children.length - 1) * V_GAP;

    const subtreeH = Math.max(NODE_H, childrenHeight);

    const node = {
      el,
      id: el.getAttribute("ID") || "",
      text,
      depth,
      side,
      width,
      height: NODE_H,
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
  root.y = -NODE_H / 2;

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
      // Visual fallback only. We do not persist this unless a structural
      // move makes this node a top-level node.
      if (rightEls.length <= leftEls.length) {
        rightEls.push(el);
      } else {
        leftEls.push(el);
      }
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

    if (side === "right") {
      node.x = anchorX;
    } else {
      node.x = anchorX - node.width;
    }

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
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
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

function estimateWidth(text: string): number {
  const t = text || " ";
  const len = Math.min(t.length, 80);
  return Math.max(60, len * 7 + 30);
}