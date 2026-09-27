/**
 * mm/render.ts
 * SVG DOM builder. Turns the layout tree into <g> node groups (rect +
 * multiline text or a Markdown foreignObject), fold/rich/edit circles,
 * DETAILS/NOTE preview blocks with separator lines and clickable
 * [[link]] tspans, and bezier edge paths between parent and child.
 * All interaction is delegated back to the view via `handlers`.
 */
import { wikiLabel } from "./md";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an element in the SVG namespace with attributes. */
function svgEl(tag: string, attrs: Record<string, any> = {}): any {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

/** Clear the svg and render edges + nodes for the given layout. */
export function renderMap(
  svg: SVGSVGElement,
  layout: any,
  selectedIds: Set<string>,
  handlers: any
) {
  svg.innerHTML = "";                              // full redraw each pass

  if (!layout || !layout.rootId) {                 // nothing to draw
    svg.setAttribute("viewBox", "0 0 800 600");
    return;
  }

  svg.setAttribute("viewBox", layout.viewBox.join(" "));
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));

  const edgeLayer = svgEl("g", { class: "fp-edges" });   // connectors below
  const nodeLayer = svgEl("g", { class: "fp-nodes" });   // nodes above
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  for (const edge of layout.edges) {
    edgeLayer.appendChild(svgEl("path", { class: "fp-edge", d: edgePath(edge.from, edge.to) }));
  }
  for (const node of layout.nodes) {
    nodeLayer.appendChild(renderNode(node, selectedIds, handlers));
  }
}

/** Build one node group: box, title (or markdown), circles, preview. */
function renderNode(n: any, selectedIds: Set<string>, handlers: any): SVGGElement {
  const g = svgEl("g", {
    class: "fp-node",
    transform: `translate(${n.x},${n.y})`,         // layout position
    "data-id": n.id,
    "pointer-events": "all",
    style: "cursor: grab;"
  });

  if (selectedIds.has(n.id)) g.classList.add("selected"); // selection outline

  const rect = svgEl("rect", { width: n.width, height: n.height, rx: 7 });
  g.appendChild(rect);

  if (n.isMarkdown) {
    // Markdown/MathJax/wikilink nodes render into an HTML foreignObject
    const fo = svgEl("foreignObject", {
      class: "fp-fo",
      x: 0,
      y: 0,
      width: n.width,
      height: n.textHeight
    });
    const div = document.createElement("div");    // filled by the view's pass
    div.className = "fp-md";
    if (n.wrapMarkdown) {
      div.classList.add("fp-md-wrap");
      div.style.width = "max-content";
      div.style.maxWidth = `${n.pixelLimit + 20}px`;
      div.style.whiteSpace = "normal";
      div.style.overflowWrap = "anywhere";
    }
    if (n.fontBold) div.style.fontWeight = "700";
    if (n.fontItalic) div.style.fontStyle = "italic";
    div.setAttribute("data-id", n.id);
    fo.appendChild(div);
    g.appendChild(fo);
  } else {
    // left-aligned multiline title, 16px per line, vertically centered
    const lines = n.lines || [n.text];
    const startY = n.textHeight / 2 + 4 - (lines.length - 1) * 8;
    lines.forEach((ln: string, i: number) => {
      const t = svgEl("text", { x: 10, y: startY + i * 16, "text-anchor": "start",
        ...(n.fontBold ? { "font-weight": "700" } : {}), ...(n.fontItalic ? { "font-style": "italic" } : {}) });
      appendInlineRuns(t, ln || " ");
      g.appendChild(t);
    });
  }

  if (n.imageUri && n.imageSize) {
    const iw = n.imageSize.w * n.imageScale;
    const ih = n.imageSize.h * n.imageScale;
    const image = svgEl("image", {
      class: "fp-node-image",
      x: (n.width - iw) / 2,
      y: n.textHeight + 6,
      width: iw,
      height: ih,
      preserveAspectRatio: "xMidYMid meet"
    }) as SVGImageElement;
    const url = handlers.imageUrl(n.imageUri);
    if (url) {
      image.addEventListener("load", () => handlers.imageLoaded(n.id, image));
      image.setAttribute("href", url);
    }
    g.appendChild(image);
  }

  if (n.hasRich) {
    // left circle: show/hide DETAILS+NOTE preview (writes HIDDEN attr)
    const richCircle = svgEl("circle", { class: "fp-rich-toggle", cx: -10, cy: n.titleHeight / 2, r: 7 });
    const richSign = svgEl("text", { class: "fp-rich-sign", x: -10, y: n.titleHeight / 2 + 4, "text-anchor": "middle" });
    richSign.textContent = n.richExpanded ? "↑" : "↓";
    richCircle.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); handlers.toggleRich(n.id); });
    g.appendChild(richCircle);
    g.appendChild(richSign);
  }

  if (n.richExpanded && (n.hasDetails || n.hasNote)) {
    // left "→" circles: open the inline editor for DETAILS / NOTE
    let ey = n.titleHeight / 2 + 18;
    const types: Array<"DETAILS" | "NOTE"> = [];
    if (n.hasDetails) types.push("DETAILS");
    if (n.hasNote) types.push("NOTE");
    for (const t of types) {
      const c = svgEl("circle", { class: "fp-rich-edit", cx: -10, cy: ey, r: 7 });
      const sign = svgEl("text", { class: "fp-rich-edit-sign", x: -10, y: ey + 3, "text-anchor": "middle" });
      sign.textContent = "→";
      c.addEventListener("click", (ev: MouseEvent) => { ev.stopPropagation(); handlers.editRich(n.id, t); });
      g.appendChild(c);
      g.appendChild(sign);
      ey += 16;
    }
  }

  if (n.hasChildren) {
    // right circle: fold/unfold this node's children
    const foldX = n.width + 10;
    const fold = svgEl("circle", { class: "fp-fold", cx: foldX, cy: n.titleHeight / 2, r: 7 });
    const sign = svgEl("text", { class: "fp-fold-sign", x: foldX, y: n.titleHeight / 2 + 3, "text-anchor": "middle" });
    sign.textContent = n.folded ? "+" : "-";
    fold.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); handlers.toggleFold(n.id); });
    g.appendChild(fold);
    g.appendChild(sign);
  }

  if (n.richExpanded && n.richBlocks?.length) {
    renderRichBlocks(g, n, handlers);              // DETAILS/NOTE preview
  }

  // click = select (links bubble up to the view instead)
  g.addEventListener("click", (e: MouseEvent) => {
    const t = e.target as Element;
    if (t.closest && (t.closest(".fp-md a") || t.closest(".fp-rich-link"))) return;
    e.stopPropagation();
    handlers.select(n.id, e);
  });

  // double-click = rename (ignored on links / preview lines / separators)
  g.addEventListener("dblclick", (e: MouseEvent) => {
    e.stopPropagation();
    const target = e.target as Element;
    if (target.closest?.("a, .fp-rich-link, .fp-rich-line, .fp-rich-edit, .fp-rich-toggle, .fp-fold")) return;
    if (target?.classList?.contains("fp-rich-sep")) return;
    handlers.editText(n.id);
  });

  // pointerdown = start drag (ignored on circles, links, preview lines)
  g.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as Element;
    if (target.closest?.(".fp-rich-line")) return;
    if (target.closest && (target.closest(".fp-md a") || target.closest(".fp-rich-link"))) return;
    if (target.classList && (
      target.classList.contains("fp-fold") ||
      target.classList.contains("fp-rich-toggle") ||
      target.classList.contains("fp-rich-line") ||
      target.classList.contains("fp-rich-sep") ||
      target.classList.contains("fp-rich-edit")
    )) return;
    if (e.button !== 0) return;                    // left button only
    handlers.startDrag(n.id, e);
  });

  // right-click = node context menu
  g.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target as Element;
    const link = target.closest?.("a.internal-link, a.external-link, .fp-rich-link, .internal-embed");
    if (link) { handlers.linkContextMenu(link, e); return; }
    handlers.contextMenu(n.id, e);
  });

  return g;
}

/**
 * DETAILS/NOTE preview: one separator line per block (no captions),
 * then wrapped lines; [[wikilinks]] inside a line become clickable
 * accent-colored tspans.
 */
function renderRichBlocks(g: SVGGElement, n: any, handlers: any) {
  let y = n.titleHeight + 12;                      // first line baseline

  let firstSep = true;
  for (const block of n.richBlocks) {
    const lineH = block.lineH;
    const sepY = y - (firstSep ? 14 : 11);         // header sep sits 3px higher
    firstSep = false;
    const lines = block.markdown ? Math.ceil(block.size.h / lineH) : block.lines.length;
    const bottom = block === n.richBlocks[n.richBlocks.length - 1]
      ? n.height : y + lines * lineH + 4 - 11;
    const hit = svgEl("rect", {
      class: "fp-rich-line fp-rich-hit",
      x: 0, y: sepY, width: n.width, height: Math.max(0, bottom - sepY),
      "data-id": n.id, "data-type": block.type
    });
    hit.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      handlers.richClick(n.id, block.type);
    });
    g.appendChild(hit);
    g.appendChild(svgEl("line", {
      class: "fp-rich-sep",
      x1: 8, x2: n.width - 8,
      y1: sepY, y2: sepY,
      "data-id": n.id,
      "data-type": block.type
    }));

    if (block.markdown) {
      const fo = svgEl("foreignObject", { x: 0, y: y - 10, width: n.width, height: block.size.h, class: "fp-rich-line", "data-id": n.id, "data-type": block.type });
      const div = document.createElement("div");
      div.className = "fp-md";
      if (!/\\latex|!\[\[/.test(block.markdown)) {
        div.classList.add("fp-md-wrap");
        div.style.maxWidth = `${n.pixelLimit + 20}px`;
      }
      div.setAttribute("data-id", n.id);
      div.setAttribute("data-type", block.type);
      div.setAttribute("data-source", block.markdown);
      div.addEventListener("click", (e) => { if ((e.target as Element).closest("a")) return; e.stopPropagation(); handlers.richClick(n.id, block.type); });
      fo.appendChild(div); g.appendChild(fo);
      y += Math.ceil(block.size.h / lineH) * lineH + 4;
      continue;
    }
    for (const line of block.lines) {
      const t = svgEl("text", {
        class: "fp-rich-line",
        x: 10,
        y: y + Math.max(0, block.fontSize - 12),
        "text-anchor": "start",
        "data-id": n.id,
        "data-type": block.type
      });

      appendInlineRuns(t, line || " ");

      // single click on plain text = manual double-click detection target
      t.addEventListener("click", (e: MouseEvent) => {
        const tgt = e.target as Element;
        if (tgt.closest && tgt.closest(".fp-rich-link")) return; // let links bubble
        e.stopPropagation();
        handlers.richClick(n.id, block.type);
      });
      g.appendChild(t);
      y += lineH;
    }
    y += 4;                                        // gap between blocks
  }
}

/** Render lightweight emphasis and wikilinks without an HTML foreignObject. */
function appendInlineRuns(parent: SVGTextElement, line: string) {
  const parts = line.split(/(!?\[\[[^\]\n]*\]\]|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g);
  for (const part of parts) {
    if (!part) continue;
    const link = /^(!?)\[\[([^\]\n]*)\]\]$/.exec(part);
    if (link) {
      const tspan = svgEl("tspan", { class: "fp-rich-link", "data-href": link[2] });
      tspan.textContent = wikiLabel(link[2]);
      parent.appendChild(tspan);
      continue;
    }
    const both = /^\*\*\*([^*\n]+)\*\*\*$/.exec(part);
    const bold = /^\*\*([^*\n]+)\*\*$/.exec(part) || /^__([^_\n]+)__$/.exec(part);
    const italic = /^\*([^*\n]+)\*$/.exec(part) || /^_([^_\n]+)_$/.exec(part);
    const tspan = svgEl("tspan", both ? { "font-weight": "700", "font-style": "italic" }
      : bold ? { "font-weight": "700" } : italic ? { "font-style": "italic" } : {});
    tspan.textContent = both?.[1] || bold?.[1] || italic?.[1] || part;
    parent.appendChild(tspan);
  }
}

/** Bezier connector between parent and child (side-aware). */
function edgePath(from: any, to: any): string {
  const fromY = from.y + from.titleHeight / 2;     // vertical center of title
  const toY = to.y + to.titleHeight / 2;

  if (to.side === "right") {
    const x1 = from.x + from.width;                // parent right edge
    const x2 = to.x;                               // child left edge
    const mx = (x1 + x2) / 2;                      // control point midpoint
    return `M ${x1} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${x2} ${toY}`;
  } else {
    const x1 = from.x;                             // parent left edge
    const x2 = to.x + to.width;                    // child right edge
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${x2} ${toY}`;
  }
}
