# Freeplane Mind Map — Obsidian plugin

View and edit Freeplane `.mm` mind-map files directly inside Obsidian.
The `.mm` file on disk is the authoritative source (read → mutate DOM → write).

Targets: Obsidian 1.6.5 / 1.6.7 (no post-1.7 APIs), Freeplane 1.9.14 file format.

## Features
- Custom file view: `.mm` files open in the mind-map view by default.
- SVG rendering with Freeplane-style semantic layout (no x/y stored in file).
- Fold/unfold via `FOLDED="true"`; DETAILS/NOTE visibility via `HIDDEN="true"`.
- Inline editing of node TEXT; sidebar editor for TEXT / DETAILS / NOTE.
- DETAILS/NOTE preview under nodes (separator-delimited), `[[links]]` shown
  as clickable links; Ctrl+hover = page preview, Ctrl+click = open.
- Markdown pass: nodes containing `\latex`, `[[`, `![[` render through
  Obsidian's MarkdownRenderer (MathJax, wikilinks, Excalidraw embeds).
- Drag & drop re-parenting / sibling reordering (DOM mutations only).
- Snapshot undo/redo; save only via Ctrl+S / menu / command (never on close).
- Link suggest popup (`[[` / `![[`) in all text editors.
- New-map creator (navigator context menu + palette) in Freeplane 1.9 format.
- Pan (LMB on empty space), zoom (Ctrl+wheel, +/− buttons), fit/center menu.

## File listing
| File | Contents |
| --- | --- |
| `manifest.json` | Obsidian plugin manifest (id, version, minAppVersion). |
| `styles.css` | All view CSS: canvas, nodes, circles, separators, editors, suggest, preview, sidebar. |
| `src/main.ts` | Plugin entry: view registration, `.mm` association, menus, palette commands, new-map creator. |
| `src/FreeplaneView.ts` | The view: lifecycle, rendering orchestration, editing, hotkeys, drag&drop, zoom/pan, sidebar, link preview, `LinkSuggest` class. |
| `src/history.ts` | `SnapshotHistory`: undo/redo stack of serialized XML snapshots. |
| `src/mm/xml.ts` | XML safety layer: parse (with HTML-entity repair), serialize (`&#xa;`), node/richcontent helpers, structural `moveNode`. |
| `src/mm/layout.ts` | Semantic tree layout: sizes, wrapping, left/right sides, rich preview blocks, markdown size cache, bounds/viewBox. |
| `src/mm/render.ts` | SVG DOM builder: edges, nodes, fold/rich circles, separators, rich preview lines with link tspans, markdown foreignObject. |
| `src/mm/md.ts` | `needsMarkdown()` / `toMarkdown()` (`\latex …` → `$…$`). |
| `src/ui/UnsavedPrompt.ts` | Save / Discard / Cancel modal used on file switch and close command. |

## Build & deploy
npm install
npm run build # esbuild → main.js
Copy `main.js`, `manifest.json`, `styles.css` into
`<vault>/.obsidian/plugins/obsidian-freeplane/`, restart Obsidian.

## Hotkeys (view active, layout-independent letters)
| Key | Action |
| --- | --- |
| Ctrl+S / Ctrl+Z / Ctrl+Shift+Z | save / undo / redo |
| Ctrl+E / Ctrl+D | rename node / edit DETAILS |
| Ctrl+Space, Shift+Space, Space | toggle details preview / same / fold node |
| Arrows | navigate: siblings / parent / first child (leaf: first↔last sibling) |
| Ctrl+Arrows | move: reorder cyclic / promote / demote |
| Enter / Shift+Enter / Insert / Delete | new sibling below / above / child / delete |
| F2-free: double-click or Ctrl+E | rename |

## XML safety rules
- Only TEXT, FOLDED, HIDDEN, POSITION (top-level), richcontent children and
  node structure are ever modified; unknown attributes/tags/order preserved.
- DOM mutation + XMLSerializer; save re-parses first and refuses invalid XML.
- HTML named entities (`&nbsp;`…) are converted to numeric form on load.

## Known limitations
- Tab-close cannot be reliably intercepted by plugins; use the
  "Close current Freeplane map" command for the Save/Discard/Cancel prompt.
- Pinch-zoom on touch screens unsupported; use +/− buttons or Ctrl+wheel.
