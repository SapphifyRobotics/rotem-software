const local = new Set(['localhost', '127.0.0.1', '[::1]']);
export function allowedRequest(req, requireOrigin = true) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    if (!local.has(host.hostname)) return false;
    const origin = req.headers.origin;
    if (!origin) return !requireOrigin;
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host === host.host;
  } catch { return false; }
}
