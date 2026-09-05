const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, any> = {}): any {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

export function renderMap(
  svg: SVGSVGElement,
  layout: any,
  selectedId: string | null,
  handlers: any
) {
  svg.innerHTML = "";

  if (!layout || !layout.rootId) {
    svg.setAttribute("viewBox", "0 0 800 600");
    return;
  }

  svg.setAttribute("viewBox", layout.viewBox.join(" "));
  svg.setAttribute("width", String(layout.width));
  svg.setAttribute("height", String(layout.height));

  const edgeLayer = svgEl("g", { class: "fp-edges" });
  const nodeLayer = svgEl("g", { class: "fp-nodes" });
  svg.appendChild(edgeLayer);
  svg.appendChild(nodeLayer);

  for (const edge of layout.edges) {
    edgeLayer.appendChild(svgEl("path", { class: "fp-edge", d: edgePath(edge.from, edge.to) }));
  }

  for (const node of layout.nodes) {
    nodeLayer.appendChild(renderNode(node, selectedId, handlers));
  }
}

function renderNode(n: any, selectedId: string | null, handlers: any): SVGGElement {
  const g = svgEl("g", {
    class: "fp-node",
    transform: `translate(${n.x},${n.y})`,
    "data-id": n.id,
    "pointer-events": "all",
    style: "cursor: grab;"
  });

  if (n.id === selectedId) g.classList.add("selected");

  const rect = svgEl("rect", { width: n.width, height: n.height, rx: 7 });

  g.appendChild(rect);

  if (n.isMarkdown) {
    const fo = svgEl("foreignObject", {
      class: "fp-fo",
      x: 0,
      y: 0,
      width: n.width,
      height: n.titleHeight
    });
    const div = document.createElement("div");
    div.className = "fp-md";
    div.setAttribute("data-id", n.id);
    fo.appendChild(div);
    g.appendChild(fo);
  } else {
    // left-aligned multiline title
    const lines = n.lines || [n.text];
    const startY = n.titleHeight / 2 + 4 - (lines.length - 1) * 8;
    lines.forEach((ln: string, i: number) => {
      const t = svgEl("text", { x: 10, y: startY + i * 16, "text-anchor": "start" });
      t.textContent = ln ? displayText(ln) : " ";
      g.appendChild(t);
    });
  }


  if (n.hasRich) {
    const richCircle = svgEl("circle", { class: "fp-rich-toggle", cx: -10, cy: n.titleHeight / 2, r: 7 });
    const richSign = svgEl("text", { class: "fp-rich-sign", x: -10, y: n.titleHeight / 2 + 4, "text-anchor": "middle" });
    richSign.textContent = n.richExpanded ? "↑" : "↓";
    richCircle.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); handlers.toggleRich(n.id); });
    g.appendChild(richCircle);
    g.appendChild(richSign);
  }

  if (n.richExpanded && (n.hasDetails || n.hasNote)) {
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
    const foldX = n.width + 10;
    const fold = svgEl("circle", { class: "fp-fold", cx: foldX, cy: n.titleHeight / 2, r: 7 });
    const sign = svgEl("text", { class: "fp-fold-sign", x: foldX, y: n.titleHeight / 2 + 3, "text-anchor": "middle" });
    sign.textContent = n.folded ? "+" : "-";
    fold.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); handlers.toggleFold(n.id); });
    g.appendChild(fold);
    g.appendChild(sign);
  }

  if (n.richExpanded && n.richBlocks?.length) {
    renderRichBlocks(g, n, handlers);
  }

  g.addEventListener("click", (e: MouseEvent) => { e.stopPropagation(); handlers.select(n.id); });

  g.addEventListener("dblclick", (e: MouseEvent) => {
    e.stopPropagation();
    const target = e.target as Element;
    if (target.closest && target.closest(".fp-md a")) return;
    if (target?.classList?.contains("fp-rich-line")) return;
    if (target?.classList?.contains("fp-rich-sep")) return;
    handlers.editText(n.id);
  });

  g.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as Element;
    if (target.closest && (target.closest(".fp-md a") || target.closest(".fp-rich-link"))) return;
    if (target.classList && (
      target.classList.contains("fp-fold") ||
      target.classList.contains("fp-rich-toggle") ||
      target.classList.contains("fp-rich-line") ||
      target.classList.contains("fp-rich-sep") ||
      target.classList.contains("fp-rich-edit")
    )) return;
    if (e.button !== 0) return;
    if (target.closest && target.closest(".fp-rich-link")) return;
    handlers.startDrag(n.id, e);
  });

  g.addEventListener("contextmenu", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    handlers.contextMenu(n.id, e);
  });

  return g;
}

// No "DETAILS/NOTE" captions: a thin separator before each block instead.
function renderRichBlocks(g: SVGGElement, n: any, handlers: any) {
  let y = n.titleHeight + 12;

  let firstSep = true;
  for (const block of n.richBlocks) {
    const sepY = y - (firstSep ? 14 : 11);
    firstSep = false;
    g.appendChild(svgEl("line", {
      class: "fp-rich-sep",
      x1: 8, x2: n.width - 8,
      y1: sepY, y2: sepY,
      "data-id": n.id,
      "data-type": block.type
    }));

    for (const line of block.lines) {
      const t = svgEl("text", {
        class: "fp-rich-line",
        x: 10,
        y,
        "text-anchor": "start",
        "data-id": n.id,
        "data-type": block.type
      });

      const parts = (line || " ").split(/(!?\[\[[^\]\n]*\]\])/g);
      for (const part of parts) {
        if (!part) continue;
        const m = /^(!?)\[\[([^\]\n]*)\]\]$/.exec(part);
        if (m) {
          const ts = svgEl("tspan", { class: "fp-rich-link", "data-href": m[2] });
          ts.textContent = m[2];
          t.appendChild(ts);
        } else {
          const ts = svgEl("tspan");
          ts.textContent = part;
          t.appendChild(ts);
        }
      }

      t.addEventListener("click", (e: MouseEvent) => {
        const tgt = e.target as Element;
        if (tgt.closest && tgt.closest(".fp-rich-link")) return; // let links bubble
        e.stopPropagation();
        handlers.richClick(n.id, block.type);
      });
      g.appendChild(t);
      y += n.richLineH;
    }

    y += 4;
  }
}

function edgePath(from: any, to: any): string {
  const fromY = from.y + from.titleHeight / 2;
  const toY = to.y + to.titleHeight / 2;

  if (to.side === "right") {
    const x1 = from.x + from.width;
    const x2 = to.x;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${x2} ${toY}`;
  } else {
    const x1 = from.x;
    const x2 = to.x + to.width;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${fromY} C ${mx} ${fromY}, ${mx} ${toY}, ${x2} ${toY}`;
  }
}

function displayText(text: string): string {
  if (!text) return " ";
  return text.length > 80 ? text.slice(0, 79) + "…" : text;
}
