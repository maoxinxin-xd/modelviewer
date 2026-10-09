/** Never include credentials, query tokens or inline media payloads in diagnostics. */
export function safeText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
    catch { return '[URL omitted]'; }
  }).replace(/data:[^\s"'<>]+/gi, 'data:[payload omitted]');
}
export function safeDiagnostics(value) {
  if (typeof value === 'string') return safeText(value);
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(safeDiagnostics);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeDiagnostics(item)]));
}
