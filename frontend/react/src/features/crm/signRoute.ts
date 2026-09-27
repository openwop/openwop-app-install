/**
 * Public signing route matcher (ADR 0402 §b) — the unauthed page at /sign/:token,
 * mounted in App.tsx above the auth gate. The token is the signer's capability.
 */
export function matchSignToken(pathname: string): { token: string } | null {
  const m = pathname.match(/^\/sign\/([A-Za-z0-9%_-]+)$/);
  if (!m) return null;
  try { return { token: decodeURIComponent(m[1]!) }; } catch { return null; }
}
