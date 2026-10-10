/**
 * ADR 0766 — read a pack manifest the way the HOST sees it.
 *
 * Since P3 every in-tree chain reference is pinned (`core.ai.chatCompletion@1.0.0`),
 * but the loader registers chains with BARE typeIds and keeps the pins in a side
 * record (`normalizeChainPins`, D1). A test that `JSON.parse`s a chain `pack.json`
 * and compares `node.typeId` against a node pack, a schema, or a generator is asking
 * the host's question, so it should read the host's answer. Seven tests went
 * vacuous at once when the pins landed — their fixture guards fired "nothing was
 * checked", which is the only reason the gap was visible at all.
 *
 * Node-pack manifests (no `chains`) come back unchanged.
 */
import { readFileSync } from 'node:fs';
import { normalizeChainPins } from '../../src/host/chainPinRule.js';

export function readPackManifest<T>(path: string | URL): T {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { chains?: unknown };
  if (!Array.isArray(raw.chains)) return raw as T;
  return { ...raw, chains: raw.chains.map((c) => normalizeChainPins(c as Record<string, unknown>).chain) } as T;
}
