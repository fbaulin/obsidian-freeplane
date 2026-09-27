import { Plugin, TFile, ItemView } from "obsidian";

/** Display map links in the existing core pane without replacing its view. */
export function installMapOutgoingLinks(plugin: Plugin) {
  const { workspace, metadataCache: cache } = plugin.app;
  const mounted = new Map<HTMLElement, HTMLElement>();
  let disposed = false, scheduled = false;
  const clear = (container: HTMLElement) => {
    mounted.get(container)?.remove(); mounted.delete(container);
    container.classList.remove('fp-outgoing-map');
  };
  const render = () => {
    if (disposed) return;
    const live = new Set<HTMLElement>();
    for (const leaf of workspace.getLeavesOfType('outgoing-link')) {
      const view = leaf.view as ItemView;
      const container = view.contentEl;
      if (!container) continue;
      live.add(container);
      // A pane explicitly assigned a file should keep that file; otherwise
      // follow the workspace's active file, including when the sidebar focuses.
      const state = view.getState();
      const explicit = typeof state?.file === 'string' ? plugin.app.vault.getAbstractFileByPath(state.file) : null;
      const file = explicit instanceof TFile ? explicit : workspace.getActiveFile();
      if (!file || file.extension !== 'mm') { clear(container); continue; }
      let panel = mounted.get(container);
      if (!panel) { panel = container.createDiv({ cls: 'fp-outgoing-list' }); mounted.set(container, panel); }
      container.classList.add('fp-outgoing-map');
      panel.empty();
      const data = cache.getFileCache(file);
      const groups = new Map<string, { link: string; label: string; count: number; resolved: boolean }>();
      for (const item of [...data?.links || [], ...data?.embeds || []]) {
        const target = item.link.split('#')[0];
        let decoded = target; try { decoded = decodeURIComponent(target); } catch {}
        const dest = cache.getFirstLinkpathDest(decoded || file.path, file.path);
        const key = dest?.path || item.link;
        const previous = groups.get(key);
        if (previous) previous.count++;
        else groups.set(key, { link: item.link, label: dest?.name || decoded || item.link, count: 1, resolved: !!dest });
      }
      panel.createDiv({ cls: 'fp-outgoing-title', text: `Links (${groups.size})` });
      if (!groups.size) panel.createDiv({ cls: 'fp-outgoing-empty', text: 'No outgoing links in this map.' });
      for (const item of Array.from(groups.values()).sort((a, b) => a.label.localeCompare(b.label))) {
        const row = panel.createDiv({ cls: 'fp-outgoing-row' });
        const link = row.createEl('a', { text: item.label, cls: 'internal-link' + (item.resolved ? '' : ' is-unresolved'), href: item.link });
        link.setAttribute('aria-label', item.link);
        link.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          void workspace.openLinkText(item.link, file.path, event.ctrlKey || event.metaKey);
        });
        link.addEventListener('auxclick', event => {
          if (event.button !== 1) return;
          event.preventDefault(); void workspace.openLinkText(item.link, file.path, true);
        });
        row.createSpan({ cls: 'fp-outgoing-count', text: String(item.count) });
      }
    }
    for (const container of mounted.keys()) if (!live.has(container)) clear(container);
  };
  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; render(); });
  };
  plugin.registerEvent(workspace.on('file-open', schedule));
  plugin.registerEvent(workspace.on('active-leaf-change', schedule));
  plugin.registerEvent(workspace.on('layout-change', schedule));
  plugin.registerEvent(cache.on('resolved', schedule));
  workspace.onLayoutReady(schedule);
  plugin.register(() => { disposed = true; for (const container of mounted.keys()) clear(container); });
}
