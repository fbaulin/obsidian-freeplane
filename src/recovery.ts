/**
 * recovery.ts
 * Unsaved-work recovery storage inside the plugin folder:
 *   recovery/<key>.tmp  - JSON envelope { xml, undo[], redo[], at }
 *   recovery/cache.json - key -> { mmPath, hash, mtime, at }
 * The hash/mtime describe the .mm ON DISK at the moment the tmp was
 * written, so on next open we can tell whether the mm changed externally.
 */
export interface RecoveryEnvelope { xml: string; undo: string[]; redo: string[]; at: number; }
export interface RecoveryCacheEntry { mmPath: string; hash: string; mtime: number; at: number; }

/** FNV-1a 32-bit string hash (cheap, dependency-free). */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Vault path -> safe file name for the tmp/cache key. */
export function recoveryKey(path: string): string {
  return path.replace(/[\/\\:*?"<>|]/g, "_");
}

function tmpPath(dir: string, key: string) { return dir + "/recovery/" + key + ".tmp"; }
function cachePath(dir: string) { return dir + "/recovery/cache.json"; }

async function ensureDir(adapter: any, dir: string) {
  if (!(await adapter.exists(dir + "/recovery"))) await adapter.mkdir(dir + "/recovery");
}

/** Read the stash envelope; null when absent or corrupt. */
export async function readEnvelope(adapter: any, dir: string, key: string): Promise<RecoveryEnvelope | null> {
  try {
    const p = tmpPath(dir, key);
    if (!(await adapter.exists(p))) return null;
    return JSON.parse(await adapter.read(p)) as RecoveryEnvelope;
  } catch { return null; }
}

/** Write the stash envelope (creates the recovery folder if needed). */
export async function writeEnvelope(adapter: any, dir: string, key: string, env: RecoveryEnvelope) {
  await ensureDir(adapter, dir);
  await adapter.write(tmpPath(dir, key), JSON.stringify(env));
}

/** Read the whole cache map; {} when absent or corrupt. */
export async function readCache(adapter: any, dir: string): Promise<Record<string, RecoveryCacheEntry>> {
  try {
    const p = cachePath(dir);
    if (!(await adapter.exists(p))) return {};
    return JSON.parse(await adapter.read(p));
  } catch { return {}; }
}

export async function writeCache(adapter: any, dir: string, cache: Record<string, RecoveryCacheEntry>) {
  await ensureDir(adapter, dir);
  await adapter.write(cachePath(dir), JSON.stringify(cache, null, 2));
}

/** Remove one map's tmp + cache entry (after save / discard / save-as). */
export async function deleteRecovery(adapter: any, dir: string, key: string) {
  try {
    const p = tmpPath(dir, key);
    if (await adapter.exists(p)) await adapter.remove(p);
    const cache = await readCache(adapter, dir);
    if (cache[key]) { delete cache[key]; await writeCache(adapter, dir, cache); }
  } catch {}
}
