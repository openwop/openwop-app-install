import type { FeatureOffline } from '../src/sw/offlineTypes.js';

export declare const PUSH_HANDLERS_PATH: string;
export declare const OFFLINE_ENGINE_PATH: string;
export declare const OFFLINE_PURGE_PATH: string;
export declare const LEGACY_PURGE_PATH: string;
export declare const OFFLINE_CACHE_PREFIX: string;
export declare const SHELL_URL: string;
export declare const DEFAULT_PRECACHE_MAX_KB: number;

export interface NeverCacheRule { glob: string; source: string }
export interface OfflineFeature { id: string; dir: string; offline: FeatureOffline }
export interface OfflineTable {
  version: string;
  shellUrl: string;
  precache: string[];
  navigations: string[];
  neverCache: string[];
  runtime: { match: string; strategy: 'swr' | 'network-first'; maxEntries: number }[];
}
export interface BundleItem {
  type: 'chunk' | 'asset';
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
  isEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  moduleIds?: string[];
  viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> };
}

export interface LegacyCachePurge { names: string[]; prefixes: string[] }

export declare function generateServiceWorker(table?: OfflineTable | null, options?: { legacyCachePurge?: LegacyCachePurge | null }): string;
export declare function parseLegacyCachePurge(value: string | undefined): LegacyCachePurge;
export declare function firebaseGlobToRegExpSource(glob: string): string;
export declare function deriveNeverCache(hostingConfig: unknown, target?: string): NeverCacheRule[];
export declare function findOfflineDeclarationFiles(registrySource: string, registryPath: string): { id: string; dir: string; file: string }[];
export declare function checkOfflineShape(id: string, offline: unknown): string[];
export declare function checkOfflineTable(args: { features: OfflineFeature[]; neverCache: NeverCacheRule[]; startUrl: string }): string[];
export declare function prepareOfflineBuild(args: {
  registrySource: string;
  registryPath: string;
  importModule: (file: string) => Promise<{ offline?: unknown }>;
  hostingConfigPath: string;
  hostingTarget?: string;
  startUrl?: string;
}): Promise<{ features: OfflineFeature[]; neverCache: NeverCacheRule[] }>;
export declare function resolveHostingConfigPath(repoRoot: string, configured: string | undefined): string;
export declare function computePrecache(args: {
  bundle: Record<string, BundleItem>;
  features: OfflineFeature[];
  budgetKb?: number;
  readPublicFile: (path: string) => Uint8Array | null;
}): { precache: string[]; version: string; sizes: { id: string; gzipKb: number; chunks: number }[]; errors: string[] };
export declare function buildOfflineTable(args: {
  features: OfflineFeature[];
  neverCache: NeverCacheRule[];
  precache: string[];
  version: string;
}): OfflineTable;
