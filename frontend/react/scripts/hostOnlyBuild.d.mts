import type { Plugin } from 'vite';

export declare const HOST_ONLY_ENV: 'OPENWOP_BUDGET_HOST_ONLY';
export declare const NO_ADOPTER_DIR: string;
export declare function stripAdopter(code: string, id: string): string | null;
export declare function hostOnlyPlugin(opts: {
  env?: Record<string, string | undefined>;
  distribution?: string;
  root: string;
}): Plugin[];
