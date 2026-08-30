const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, any> = {}): any {
  const el = document.createElementNS(SVG_NS, tag);

  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }

  return el;
}

export function renderMap(
  svg: SVGSVGElement,
  layout: any,
  selectedId: string | null,
  handlers: {
    select: (id: string) => void;
    toggleFold: (id: string) => void;
    startDrag: (id: string, e: PointerEvent) => void;
    editText: (id: string) => void;
  }
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
    const path = svgEl("path", {
      class: "fp-edge",
      d: edgePath(edge.from, edge.to)
    });

    edgeLayer.appendChild(path);
  }

  for (const node of layout.nodes) {
    nodeLayer.appendChild(renderNode(node, selectedId, handlers));
  }
}

function renderNode(
  n: any,
  selectedId: string | null,
  handlers: {
    select: (id: string) => void;
    toggleFold: (id: string) => void;
    startDrag: (id: string, e: PointerEvent) => void;
    editText: (id: string) => void;
  }
): SVGGElement {
  const g = svgEl("g", {
    class: "fp-node",
    transform: `translate(${n.x},${n.y})`,
    "data-id": n.id
  });

  if (n.id === selectedId) {
    g.classList.add("selected");
  }

  const rect = svgEl("rect", {
    width: n.width,
    height: n.height,
    rx: 7
  });

  const title = svgEl("title");
  title.textContent = n.text || "";

  const text = svgEl("text", {
    x: n.width / 2,
    y: n.height / 2 + 4,
    "text-anchor": "middle"
  });

  text.textContent = displayText(n.text);

  g.appendChild(rect);
  g.appendChild(text);
  g.appendChild(title);

  if (n.hasChildren) {
    const foldX =
      n.depth === 0
        ? n.width
        : n.side === "left"
          ? 0
          : n.width;

    const fold = svgEl("circle", {
      class: "fp-fold",
      cx: foldX,
      cy: n.height / 2,
      r: 7
    });

    const sign = svgEl("text", {
      class: "fp-fold-sign",
      x: foldX,
      y: n.height / 2 + 3,
      "text-anchor": "middle"
    });

    sign.textContent = n.folded ? "+" : "-";
    sign.style.pointerEvents = "none";

    fold.addEventListener("click", (e: MouseEvent) => {
      e.stopPropagation();
      handlers.toggleFold(n.id);
    });

    g.appendChild(fold);
    g.appendChild(sign);
  }

  g.addEventListener("click", (e: MouseEvent) => {
    e.stopPropagation();
    handlers.select(n.id);
  });

  g.addEventListener("dblclick", (e: MouseEvent) => {
    e.stopPropagation();
    handlers.editText(n.id);
  });

  g.addEventListener("pointerdown", (e: PointerEvent) => {
    const target = e.target as Element;

    if (target.classList && target.classList.contains("fp-fold")) {
      return;
    }

    if (e.button !== 0) return;

    handlers.startDrag(n.id, e);
  });

  return g;
}

function edgePath(from: any, to: any): string {
  const fromY = from.y + from.height / 2;
  const toY = to.y + to.height / 2;

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