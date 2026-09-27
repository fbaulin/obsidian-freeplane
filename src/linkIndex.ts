import { Plugin, TFile, CachedMetadata, LinkCache, EmbedCache } from "obsidian";

/** Link offsets refer to the saved XML, not the Markdown search companion. */
export function mapLinkCache(xml: string): CachedMetadata {
  const links: LinkCache[] = [], embeds: EmbedCache[] = [];
  const decode = (value: string) => new DOMParser().parseFromString('<v>' + value + '</v>', 'application/xml').documentElement.textContent || value;
  const position = (offset: number) => {
    const before = xml.slice(0, offset), line = before.split('\n').length - 1;
    return { line, col: offset - before.lastIndexOf('\n') - 1, offset };
  };
  for (const match of xml.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const inner = decode(match[1]), split = inner.indexOf('|');
    const link = (split < 0 ? inner : inner.slice(0, split)).trim();
    if (!link) continue;
    const item = { link, original: match[0], displayText: split < 0 ? link : inner.slice(split + 1),
      position: { start: position(match.index!), end: position(match.index! + match[0].length) } };
    (match[0].startsWith('!') ? embeds : links).push(item);
  }
  return { links, embeds };
}

/** Obsidian doesn't parse .mm; supply its public cache/link maps for saved maps. */
export function installLinkIndex(plugin: Plugin) {
  const { vault, metadataCache: cache, workspace } = plugin.app;
  const entries = new Map<string, CachedMetadata>();
  const originalFile = cache.getFileCache, originalPath = cache.getCache;
  const getFile: typeof cache.getFileCache = function(file) { return entries.get(file.path) || originalFile.call(cache, file); };
  const getPath: typeof cache.getCache = function(path) { return entries.get(path) || originalPath.call(cache, path); };
  cache.getFileCache = getFile; cache.getCache = getPath;
  let disposed = false, emitting = false, queue = Promise.resolve();
  const owned = new Set<string>();
  const resolve = () => {
    if (disposed) return;
    for (const [path, data] of entries) {
      const resolved: Record<string, number> = {}, unresolved: Record<string, number> = {};
      for (const item of [...data.links || [], ...data.embeds || []]) {
        const target = item.link.split('#')[0];
        let decoded = target; try { decoded = decodeURIComponent(target); } catch {}
        const file = cache.getFirstLinkpathDest(decoded || path, path);
        const map = file ? resolved : unresolved, key = file?.path || target;
        map[key] = (map[key] || 0) + 1;
      }
      cache.resolvedLinks[path] = resolved; cache.unresolvedLinks[path] = unresolved;
      owned.add(path);
    }
  };
  const notify = () => { resolve(); emitting = true; try { (cache as any).trigger('resolved'); } finally { emitting = false; } };
  const refresh = (file: TFile) => {
    queue = queue.then(async () => {
      if (disposed || file.extension !== 'mm') return;
      const path = file.path, xml = await vault.read(file);
      if (disposed || file.path !== path || vault.getAbstractFileByPath(path) !== file) return;
      const data = mapLinkCache(xml); entries.set(path, data); resolve();
      (cache as any).trigger('changed', file, xml, data);
      (cache as any).trigger('resolve', file); notify();
    }).catch(error => console.error('Freeplane link index:', error));
  };
  const remove = (path: string) => {
    entries.delete(path);
    if (owned.delete(path)) { delete cache.resolvedLinks[path]; delete cache.unresolvedLinks[path]; }
  };
  plugin.registerEvent(vault.on('modify', file => { if (file instanceof TFile) refresh(file); }));
  plugin.registerEvent(vault.on('create', file => { if (file instanceof TFile) { refresh(file); notify(); } }));
  plugin.registerEvent(vault.on('delete', file => { remove(file.path); notify(); }));
  plugin.registerEvent(vault.on('rename', (file, old) => { remove(old); if (file instanceof TFile) refresh(file); notify(); }));
  plugin.registerEvent(cache.on('resolved', () => { if (!emitting) resolve(); }));
  workspace.onLayoutReady(() => { if (!disposed) for (const file of vault.getFiles()) refresh(file); });
  plugin.register(() => {
    disposed = true;
    if (cache.getFileCache === getFile) cache.getFileCache = originalFile;
    if (cache.getCache === getPath) cache.getCache = originalPath;
    for (const path of owned) { delete cache.resolvedLinks[path]; delete cache.unresolvedLinks[path]; }
    entries.clear();
  });
}
