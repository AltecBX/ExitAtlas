// The owner's key proxy (infra/worker), optional. When its URL is set in Settings, gas prices and
// charger lookups go through it with keys that never reach the phone, state work zone feeds that browsers
// may not read directly come through it, and its /v1/config can switch off any public service for everyone
// (routing, search, prices, chargers, wzdx) without an app update.

/// The proxy's base URL from what was typed, or null. HTTPS only (localhost allowed for testing).
export function proxyBase(text) {
  if (!text) return null;
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  url.pathname = url.pathname.replace(/\/*$/, '/');
  url.search = '';
  url.hash = '';
  return url;
}

/// Reads the proxy's switches. Returns { base, prices, chargers, wzdx, disabled } or null when the proxy
/// cannot be reached (then the app works as if none was set).
export async function loadProxy(text, fetchImpl = (...a) => fetch(...a)) {
  const base = proxyBase(text);
  if (!base) return null;
  try {
    const res = await fetchImpl(new URL('v1/config', base), { cache: 'no-store' });
    if (!res.ok) return null;
    const c = await res.json();
    return { base, prices: c.prices === true, chargers: c.chargers === true, wzdx: c.wzdx === true, community: c.community === true, benchmarks: c.benchmarks === true, disabled: Array.isArray(c.disabled) ? c.disabled : [] };
  } catch {
    return null;
  }
}

/// True when the proxy has switched this service off for everyone.
export function switchedOff(proxy, service) {
  return Boolean(proxy?.disabled?.includes(service));
}
