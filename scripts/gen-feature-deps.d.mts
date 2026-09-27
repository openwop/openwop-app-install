// Types for gen-feature-deps.mjs. The implementation stays plain ESM JavaScript
// (run directly by node, no build step); this declaration exists so the vitest suite
// importing it is fully typed — an untyped .mjs import resolves to `any`, which is
// banned in this repo.

export interface FeatureDepEdge {
  a: string;
  b: string;
  modules: Set<string>;
  dyn: boolean;
  declared: boolean;
  toggleable: boolean;
  alwaysOn: boolean;
  /** 0 = always-on target · 1 = primitive · 2 = soft-read · 3 = hard-dep (ADR 0446). */
  category: 0 | 1 | 2 | 3;
  disposition: string;
}

export declare function computeEdges(): {
  edges: FeatureDepEdge[];
  hardTarget: Map<string, boolean>;
};

export declare function render(): string;

export declare function textGatesOwnToggle(text: string, id: string): boolean;
