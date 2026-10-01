# Freeplane Mind Map — Obsidian plugin

View and edit Freeplane `.mm` mind-map files directly inside Obsidian.
The `.mm` file on disk is the authoritative source (read → mutate DOM → write).

Targets: Obsidian 1.6.5 / 1.6.7 (no post-1.7 APIs), Freeplane 1.9.14 file format.

## Features
- Map search: Ctrl+F opens a toolbar at the top of the canvas without an overlay.
  Enter selects the first result and releases input focus; n / Shift+n or the arrow
  buttons select next / previous matches. The toolbar displays the current count.
  Searches titles, details and notes, including folded nodes. Configure freeplane:search,
  freeplane:search-next and freeplane:search-previous in hotkeys.json.
- Node references: type `[` followed by at least one character for same-map suggestions.
  Enter/Tab inserts `[label](#fp-node:ID)`; click the rendered link to reveal the node.
- Global search: generated Markdown files in `Freeplane search index` expose saved map
  contents to Obsidian Search. Opening an index result redirects to the map view and
  selects the node corresponding to the result line. Index paths retain Unicode names.
  These generated notes refresh on map save/create/rename; do not edit them manually.
- Custom file view: `.mm` files open in the mind-map view by default.
- SVG rendering with Freeplane-style semantic layout (no x/y stored in file).
- Fold/unfold via `FOLDED="true"`; DETAILS/NOTE visibility via `HIDDEN="true"`.
- Inline editing of node TEXT; sidebar editor for TEXT / DETAILS / NOTE.
- DETAILS/NOTE preview under nodes (separator-delimited), `[[links]]` shown
  as clickable links; Ctrl+hover = page preview, Ctrl+click = open.
- Markdown pass: nodes containing `\latex`, `[[`, `![[` render through
  Obsidian's MarkdownRenderer (MathJax, wikilinks, Excalidraw embeds).
- Drag & drop re-parenting / sibling reordering (DOM mutations only).
- Shift-click, translucent Shift+drag area selection, and retractable Shift+Arrow selection;
  Delete and drag operate on the selected group.
- Ctrl+C/Ctrl+X publish lossless `application/x-freeplane-node+xml` plus a
  tab-indented `text/plain` outline; Ctrl+V prefers XML and falls back to text.
- Node and DETAILS/NOTE text support `**bold**`, `*italic*`, and `***both***`.
- Emphasized node and preview text wraps without breaking Markdown markers.
- Freeplane `\\latex` stays raw while editing and is hidden while viewing;
  `$...$` and `$$...$$` regions render as inline and display math respectively.
- Snapshot undo/redo; save only via Ctrl+S / menu / command (never on close).
- Link suggest popup (`[[` / `![[`) lists every file in the vault navigator.
- Link context menu: open, open in a new tab, or open with the default app.
- Read-only rendering of relative Freeplane `ExternalObject` image hooks.
- Adaptive DETAILS/NOTE preview width and a map-wide visibility toggle.
- New-map creator (navigator context menu + palette) in Freeplane 1.9 format.
- Excalidraw-style navigation: touchpad two-finger pan, cursor-centred pinch
  zoom, touchscreen one-finger pan and two-finger pan/pinch zoom.
- Pan (LMB on empty space), zoom (Ctrl+wheel, +/− buttons), fit/center menu.
- Canvas uses the Obsidian leaf's resizable flex area, including with the mobile keyboard open.

## Navigation settings
`settings.json` is created and upgraded in the plugin folder. Speed values are
multipliers (`1` = default, `0.5` = half speed, `2` = double speed):

```json
{
  "touchpadPanSpeed": 1,
  "touchpadZoomSpeed": 1,
  "touchscreenPanSpeed": 1,
  "touchscreenZoomSpeed": 1
}
```

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
| `src/mm/md.ts` | Markdown detection; hides the `\latex` view marker while preserving existing math delimiters. |
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
| Z | center the currently selected node |
| Ctrl+C / Ctrl+X / Ctrl+V | copy / cut / paste tab-indented node outlines |
| E / D / Shift+E / S | edit node / edit DETAILS / edit at beginning / edit with all text selected |
| Shift+Space / Ctrl+Space / Space | toggle details preview / fold or unfold entire subtree / fold node |
| Arrows | navigate: siblings / parent / last-visited child (leaf: first↔last sibling) |
| Shift+Arrows | extend selection; moving back retracts the previous step |
| Ctrl+Arrows | move all selected nodes: reorder cyclic / promote / demote |
| Enter / Shift+Enter / Insert / Delete | new sibling below / above / child / delete |
| Double-click or E | rename |
| H/J/K/L (also with Shift or Ctrl) | navigation / extend selection / move nodes, matching arrows |
| U / R / O / Shift+O / I / X | undo / redo / sibling below / sibling above / child / delete |

## XML safety rules
- Only TEXT, FOLDED, HIDDEN, POSITION (top-level), richcontent children and
  node structure are ever modified; unknown attributes/tags/order preserved.
- DOM mutation + XMLSerializer; save re-parses first and refuses invalid XML.
- HTML named entities (`&nbsp;`…) are converted to numeric form on load.

## Known limitations
- The keyboard Context Menu key opens the selected node's menu, or the canvas menu
  when nothing is selected. Shift+E edits at the start; S edits with all text selected.
  These bindings are configurable as context-menu, rename-start and rename-select-all
  under the `freeplane:` prefix in hotkeys.json. Clicking details selects its node.
- Link menus include **Show in navigation** and **Show in system explorer** (desktop).
  A normal link click selects its node; Ctrl-click opens the link. Wiki-link labels
  determine wrapping and width, including aliases, rather than the hidden link target.
- Navigation clears extra selections and pans minimally to reveal the active node.
  Clicking a node returns hotkey focus to the map. Map headers show the filename.
- Ctrl+Space collapses the selected subtree if any branch is expanded; otherwise
  it expands all branches. Custom hotkey bindings are preserved when loading.
  Shift+Space toggles details. Existing hotkeys.json overrides the shipped defaults.
- Embedded PDFs use a bounded 420 × 360 preview viewport so asynchronous PDF page
  loading cannot repeatedly resize and rebuild the map. Image embeds are unchanged.
- Settings → Freeplane Mind Map exposes all settings.json options. Changes save
  to that file and apply to open maps immediately. `detailsFontSize` defaults to
  12 pixels at 100% zoom and controls details viewing and editing (node text: 13 px).
- The Save icon turns red while the map has unsaved changes. The pane's three-dot
  menu includes **Search mind map**.
- Touch editing panel: deselect nodes by tapping empty canvas, open the right
  sidebar, and enable **Editing panel**. Create mode pans with one finger;
  Move mode toggles node selection on tap and drags selected nodes with one finger.
  Two-finger pan/zoom works in both modes. Hold the pencil to edit details.
  Drag from empty canvas in Move mode to select nodes with a rectangle;
  drag from a node to move the selection. The ⊙ button centers the current node.
  Buttons default to 33 × 33 pixels with no panel background. Set
  `"editingPanelButtonSize": 33` in the plugin's settings.json and reload to change
  their size in pixels (16–96). The setting is added automatically on load.
  Inline editing keeps the map's top-left scroll
  position fixed while the keyboard opens. The editor lives in a separate overlay
  and is kept above the keyboard without centering or resizing the map. Enter
  restores the saved scroll position. This works whether the Editing panel is enabled or disabled.
- Global search results open the map at its initial node. Use Ctrl+F in the map
  to find the desired content. Direct search-position interception was removed.
- Node backgrounds and text follow Obsidian's light/dark theme.
- Tab-close cannot be reliably intercepted by plugins; use the
  "Close current Freeplane map" command for the Save/Discard/Cancel prompt.

### Tables, strikethrough and vault links

Node text and details accept Markdown tables and `~~strikethrough~~`. These are
stored as XHTML tables and `<strike>` elements in Freeplane richcontent and
converted back to Markdown for editing. Use Shift+Enter for a new line in the
inline node editor. Existing complex HTML with merged cells remains editable as
HTML to avoid losing its structure.

Saved maps contribute wikilinks and embeds to Obsidian's metadata link index.
The index is rebuilt on plugin load and refreshed after saves and vault file
changes. Native backlink UI behavior needs validation in Obsidian. Renaming a
file uses the shortest unambiguous link; a folder is retained only when needed
to distinguish identically named files.

This release restores the original adaptive editor width constants (0.55 and
24). Install `main.js`, `styles.css`, and `manifest.json`, then reload the plugin.

The core Outgoing links pane now displays a map-specific list for `.mm` files,
including embeds, unresolved links and occurrence counts. Click opens a target;
Ctrl/Cmd-click or middle-click opens it in a new tab. Other files retain the
normal core pane. This adapter lists saved content, like the map link index.

### Branch sides

Branches without `POSITION` default to the right, without automatic balancing.
Promoting a child of the root switches its side and saves `POSITION="left"` or
`POSITION="right"` on that branch. Promoting deeper nodes preserves their side.
On left branches, horizontal navigation, Shift-selection, and promote/demote
hotkey actions mirror the right side: left goes outward, right goes toward the
root. From the root, left/right chooses a child on the corresponding side.
Up/down navigation and movement stay among siblings on the same side. Existing
edge styles and descendant XML remain intact.

### Pixel-based text layout

Maximum width remains configured in characters. Internally it becomes a pixel
limit based on a representative Latin/Cyrillic sample in the current font.
Viewing wraps and measures every line in pixels, including emphasis and link
labels. Inline node/details editors grow with their raw text up to that limit,
then wrap and grow vertically; they shrink when text is removed. Source markup
can occupy more space in editing than its rendered label in viewing.

### Formatting and long nodes

- In node, details and notes editors (including the side panel), Ctrl+B toggles
  bold and Ctrl+I toggles italic around the selection. With no selection, the
  cursor is placed between the markers. Cmd works on macOS too.
- Inline backtick code and fenced triple-backtick blocks render as code. Code
  remains Markdown when editing and is stored as XHTML code/pre content.
- `nodeMaxHeightLines` defaults to 20 and is available in the settings pane and
  settings.json. A longer node scrolls internally, including expanded details
  and notes. The limit uses the pixel equivalent of normal node text lines.
  Mouse wheel and one-finger drags scroll its content; external fold controls
  stay visible. Editors also stop growing at the configured height.
- Underscores inside identifiers or unmatched at word endings stay literal;
  standalone `_italic_` and `__bold__` remain supported.

Link-opening fix: rendered link labels (including labels split by pixel wrapping)
are no longer passed to Obsidian as part of the filename. Opening in the current
or a new tab preserves heading and PDF page references.
