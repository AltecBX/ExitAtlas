// Data manifest (manifest.json from tools/data-pipeline/build_manifest.py): which version of each data
// file to load, checked against its SHA-256, with the last set that worked as the fallback.
// Same rules as Sources/ExitAtlasCore/Data/DataManifest.swift.

/// Manifest formats this code can read. A manifest with a higher schema describes files this version
/// of the app may not understand, so it is ignored and the last good data stays in use.
export const SUPPORTED_SCHEMA = 1;

/// Throws unless `m` is a manifest this app can use.
export function validateManifest(m) {
  if (!m || m.kind !== 'manifest') throw new Error('not a data manifest');
  if (!Number.isInteger(m.schema) || m.schema > SUPPORTED_SCHEMA) throw new Error(`data schema ${m.schema} is newer than this app reads`);
  if (!Number.isInteger(m.version) || !m.files || typeof m.files !== 'object') throw new Error('manifest has no version or files');
  for (const [name, f] of Object.entries(m.files)) {
    if (!/^[0-9a-f]{64}$/.test(f?.sha256 ?? '') || !(f.bytes > 0)) throw new Error(`manifest entry for ${name} is incomplete`);
  }
  return m;
}

/// The manifest to use: the one just fetched unless it is unusable or older than the last good one
/// (a stale copy from a cache or a server rollback), in which case the last good one.
export function chooseManifest(fetched, lastGood) {
  let ok = null;
  try { ok = fetched ? validateManifest(fetched) : null; } catch { ok = null; }
  let last = null;
  try { last = lastGood ? validateManifest(lastGood) : null; } catch { last = null; }
  if (ok && (!last || ok.version >= last.version)) return { manifest: ok, fallback: last };
  return { manifest: last, fallback: null };
}

/// Versions of a file to try, newest first: the manifest's, then the last good one if it differs.
export function candidates(name, manifest, fallback) {
  const out = [];
  const a = manifest?.files?.[name];
  if (a) out.push(a);
  const b = fallback?.files?.[name];
  if (b && b.sha256 !== a?.sha256) out.push(b);
  return out;
}

/// The URL for one version of a file. The hash in the query makes each version its own cache entry.
export function fileURL(name, entry, base) {
  return new URL(`${name}?v=${entry.sha256.slice(0, 16)}`, base);
}

/// Loads a file: each candidate in turn, keeping the first whose size and SHA-256 match and that parses.
/// `io.fetchBytes(url)` returns an ArrayBuffer; `io.digestHex(buffer)` returns the SHA-256 in hex, or null
/// when the browser cannot hash (then only the size is checked); `io.dropCached(url)`, optional, removes a
/// bad copy from the offline cache so it is fetched again next time. `parse(bytes)` builds the dataset.
/// Returns { value, entry, rolledBack } or throws with every failure listed.
export async function loadVerified(name, list, base, io, parse = (b) => b) {
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    const url = fileURL(name, entry, base);
    try {
      const bytes = await io.fetchBytes(url);
      if (bytes.byteLength !== entry.bytes) throw new Error(`${bytes.byteLength} bytes, expected ${entry.bytes}`);
      const hash = await io.digestHex(bytes);
      if (hash !== null && hash !== entry.sha256) throw new Error('SHA-256 does not match the manifest');
      return { value: parse(bytes), entry, rolledBack: i > 0 };
    } catch (e) {
      errors.push(e.message);
      await io.dropCached?.(url);
    }
  }
  throw new Error(`${name}: ${errors.join('; ') || 'not in the data manifest'}`);
}

/// The manifest to remember as last good: the version of each file that actually loaded.
export function usedManifest(manifest, loaded) {
  const files = {};
  for (const [name, entry] of Object.entries(loaded)) if (entry) files[name] = entry;
  return { ...manifest, files: { ...manifest.files, ...files } };
}
