/**
 * ADR 1015 D6 — the tenant site visitor runtime build: a second entry built from
 * the SPA's own visitor modules (never a copy), served by the backend at
 * `/host/openwop-app/public/:orgId/_rt/:file` on a workspace's custom domain.
 *
 * Output: `dist-site-runtime/` with flat, hashed files plus `manifest.json`
 * (`{ entry, files[] }`). The backend serves ONLY the files that manifest names,
 * and the Dockerfile builds this into the same image as the prerender that
 * references it, so the page and its script cannot skew.
 *
 *   node node_modules/vite/bin/vite.js build -c vite.site-runtime.config.ts
 */
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const OUT = 'dist-site-runtime';
/** The eager entry loads on EVERY customer page view, so it has a hard ceiling
 *  (raw bytes; 7.5 kB today). React and the banner live in lazy chunks; a static
 *  import that pulls them in blows this at build time, not in production. */
const ENTRY_BUDGET_BYTES = 12_000;

/** Write the manifest the backend reads: the script entry, the ADR 1030 site
 *  stylesheet, and every emitted file. */
function runtimeManifest(): Plugin {
  return {
    name: 'openwop-site-runtime-manifest',
    generateBundle(_opts, bundle) {
      // A CSS-only entry leaves an empty JS chunk behind; it is never served.
      for (const [name, c] of Object.entries(bundle)) {
        if (c.type === 'chunk' && c.isEntry && c.name === 'site' && c.code.trim() === '') delete bundle[name];
      }
      const files = Object.keys(bundle).filter((f) => /\.(?:js|css)$/.test(f)).sort();
      const entry = Object.values(bundle).find((c) => c.type === 'chunk' && c.isEntry && c.name === 'main');
      if (!entry || entry.type !== 'chunk') throw new Error('site runtime: no entry chunk');
      // ADR 1030 D2 — the designed-pages stylesheet, named in the manifest so the
      // prerender links exactly the file this image holds.
      const style = Object.values(bundle).find((c) => c.type === 'asset' && /^site-[A-Za-z0-9_-]+\.css$/.test(c.fileName));
      if (!style) throw new Error('site runtime: no site stylesheet');
      const bytes = Buffer.byteLength(entry.code);
      if (bytes > ENTRY_BUDGET_BYTES) throw new Error(`site runtime: the eager entry is ${bytes} B, over its ${ENTRY_BUDGET_BYTES} B budget (keep React and the banner in lazy chunks)`);
      for (const f of files) {
        if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(?:js|css)$/.test(f)) throw new Error(`site runtime: unsafe file name ${f}`);
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: `${JSON.stringify({ entry: entry.fileName, style: style.fileName, files }, null, 2)}\n` });
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeManifest()],
  publicDir: false,
  // Imports resolve relative to the entry's own URL (the org-pinned `_rt/` path).
  base: './',
  // The runtime always calls its own hostname; never bake a platform base in.
  define: { 'import.meta.env.VITE_OPENWOP_BASE_URL': JSON.stringify('') },
  build: {
    outDir: OUT,
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { main: resolve(__dirname, 'src/site-runtime/main.ts'), site: resolve(__dirname, 'src/site-runtime/site.css') },
      output: {
        format: 'es',
        entryFileNames: 'main-[hash].js',
        chunkFileNames: 'rt-[hash].js',
        // ADR 1030 D2 — the designed-pages sheet keeps a recognisable name.
        assetFileNames: (a) => ((a.names ?? []).some((n) => n === 'site.css') ? 'site-[hash][extname]' : 'rt-[hash][extname]'),
      },
    },
  },
});
