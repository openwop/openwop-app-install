/**
 * ADR 0916 (Book AI P8) — which vendor a pasted key belongs to, by the
 * `apiKeyPrefix` values already in `providers.json`. Prefixes overlap
 * (`sk-` is a prefix of `sk-ant-`), so the LONGEST matching prefix wins.
 * Returns null when no provider's prefix matches (custom, org-scoped or
 * unprefixed keys), which the caller treats as "no opinion".
 */
export function detectProviderByKeyPrefix<P extends { id: string; apiKeyPrefix?: string | undefined }>(
  key: string,
  providers: readonly P[],
): P | null {
  const k = key.trim();
  if (!k) return null;
  let best: P | null = null;
  for (const p of providers) {
    const prefix = p.apiKeyPrefix;
    if (!prefix || !k.startsWith(prefix)) continue;
    if (!best || prefix.length > (best.apiKeyPrefix?.length ?? 0)) best = p;
  }
  return best;
}
