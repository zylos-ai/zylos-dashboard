// Only an HTTP authority is allowed: no credentials, escaping, paths or lists.
const AUTHORITY = /^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:.]+\])(?::[0-9]+)?$/;

function parseHttpSource(value, originOnly) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  const match = value.match(/^https?:\/\/([^/?#]+)/);
  if (!match || !AUTHORITY.test(match[1])) return null;
  try {
    const url = new URL(value);
    // Origin is a serialized origin, not a URL with a path, query or fragment.
    if (originOnly && value !== url.origin) return null;
    return url;
  } catch { return null; }
}

/**
 * Match the browser's source authority against the public Host preserved by
 * the reverse proxy. Internal HTTP hops and forwarded protocol headers do not
 * describe the browser's origin. Secure, schemeful SameSite=Strict cookies
 * provide the cross-scheme boundary in supported modern browsers.
 * Referer fallback is only for logout; Observer requires an explicit Origin.
 */
export function hasMatchingRequestAuthority(req, { allowReferer = false } = {}) {
  const { host, origin, referer } = req.headers;
  if (typeof host !== 'string' || !AUTHORITY.test(host)) return false;
  const source = origin !== undefined
    ? parseHttpSource(origin, true)
    : allowReferer ? parseHttpSource(referer, false) : null;
  if (!source) return false;
  try {
    // Use the source scheme solely to normalize an explicit default port in
    // Host (e.g. HTTPS :443), never to infer the proxy's external protocol.
    return new URL(`${source.protocol}//${host}`).host === source.host;
  } catch { return false; }
}
