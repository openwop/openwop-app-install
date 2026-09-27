import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
// The repo-root generator. `tsconfig.json` includes only `src/**` and `e2e/**`,
// so this config file is transformed by esbuild and never type-checked — no
// suppression is needed or wanted here.
import { generate } from '../../scripts/gen-distribution.mjs';
import { BRAND_DEFAULTS, resolveBrandFromEnv } from './src/brand/defaults';
import { DEV_FALLBACK_BASE_URL } from './src/client/baseUrlDefault';

// Vite inlines `import.meta.env.VITE_*` at build time, NOT at runtime.
// A production build with `VITE_OPENWOP_BASE_URL` unset bakes the dev
// fallback (`http://localhost:8080`) into the bundle and silently
// ships a broken deploy — the page tries to fetch localhost on every
// visitor's machine.
//
// Defense in depth on top of `.env.production`: assert the var is
// present + non-default whenever `mode === 'production'`. Catches the
// failure mode where `.env.production` is missing, gitignored, or
// renamed. Errors at config-resolution time so no broken bundle is
// ever produced.

// ADR 0366 P1b — distribution registry alias: when OPENWOP_DISTRIBUTION names
// a non-default manifest (scripts/gen-distribution.mjs runs in predev/prebuild
// via package.json), the feature registry resolves to the GENERATED
// `registry.distribution.ts` so excluded features tree-shake out of the
// bundle. Default: no alias — byte-identical build.
const distributionName = process.env.OPENWOP_DISTRIBUTION ?? 'default';
const distributionPlugin = (() => {
  if (distributionName === 'default') return [];
  const canonical = resolve(__dirname, 'src/features/registry.ts');
  // GENERATE HERE rather than reading `registry.distribution.ts` off disk.
  //
  // That file is gitignored and written by the `prebuild` npm hook, so a bare
  // `vite build` skipped generation and silently reused whatever a previous
  // build left behind. `existsSync` cannot tell "generated for THIS manifest"
  // from "generated a month ago for a different one" — and the second is what
  // happens: MEASURED 2026-08-28, the shared checkout was carrying an artifact
  // from Jul 27. The old error text promised to refuse "to build the full
  // registry silently"; it kept that promise only for the never-generated case
  // and missed the stale one, which builds a DIFFERENT distribution silently.
  //
  // Deriving the source in-process deletes the class instead of detecting it:
  // there is no file in the path to go stale, and `vite build` and
  // `npm run build` can no longer disagree. The backend wrapper already runs
  // the generator itself (backend/typescript/scripts/build.mjs) — this closes
  // the same hole on the frontend side.
  const { generated, frontendSource } = generate(distributionName, { write: false });
  if (!generated || !frontendSource) return [];
  // A load()-hook substitution keyed on the RESOLVED path — resolve.alias
  // matches import SPECIFIERS (relative strings), so an absolute-path alias
  // never engages (the backend build.mjs hit the same class via onResolve).
  return [{
    name: 'distribution-registry-substitute',
    enforce: 'pre' as const,
    load(id: string) {
      return id === canonical ? frontendSource : null;
    },
  }];
})();

export default defineConfig(({ mode }) => {
  if (mode === 'production') {
    const env = loadEnv(mode, __dirname, '');
    const baseUrl = env.VITE_OPENWOP_BASE_URL;
    if (!baseUrl || baseUrl === DEV_FALLBACK_BASE_URL) {
      throw new Error(
        `[openwop] Production build aborted — VITE_OPENWOP_BASE_URL must be set and non-default ` +
          `(got: ${baseUrl ?? '<unset>'}). Define it in ` +
          `frontend/react/.env.production, in a .env.production.local ` +
          `override, or pass it on the command line.`,
      );
    }
  }

  return {
    server: {
      port: 5173,
      strictPort: false,
      fs: {
        // Allow Vite to serve files from the workflow-engine root so
        // the frontend can import the shared providers.json sibling.
        // By default Vite blocks files outside the project root.
        allow: [resolve(__dirname, '..', '..')],
      },
      // Dev-server `/api` proxy: forward `/api/*` from the dev server to a
      // backend so the SPA and the API share an origin from the browser's POV
      // (the __session cookie then travels naturally on credentials: 'include'
      // fetches). Keeps the SPA on the same origin so cookies aren't dropped.
      //
      // DEFAULTS TO A LOCAL BACKEND (`http://localhost:8080`). This is critical
      // for white-label adopters: a remote default would silently route a
      // freshly-set-up app's dev traffic to whatever backend was baked in
      // (previously `https://app.openwop.dev` — i.e. the steward's backend),
      // leaking the adopter's data and load onto someone else's system. With a
      // local default, `npm run dev` hits the adopter's own backend (run it on
      // :8080 per WHITE-LABEL.md / DEPLOY.md).
      //
      // To proxy a REMOTE backend in dev (e.g. the steward running the SPA
      // against the deployed app.openwop.dev without a local backend), set
      // OPENWOP_DEV_PROXY_TARGET=https://app.openwop.dev in your shell or
      // `.env.local`. Phoning home is now opt-in, never the default.
      proxy: {
        '/api': {
          target: process.env.OPENWOP_DEV_PROXY_TARGET ?? DEV_FALLBACK_BASE_URL,
          changeOrigin: true,
          secure: true,
          // ADR 0359 — forward WebSocket upgrades (the canvas-collab transport)
          // through the same dev proxy the REST calls use.
          ws: true,
          // Strip Set-Cookie's Domain attribute so cookies bind to the
          // browser-visible origin (`localhost`) rather than the upstream
          // backend's domain — otherwise the browser drops them.
          cookieDomainRewrite: '',
        },
      },
    },
    // The SDK's main barrel re-exports `verifyWebhookSignature` /
    // `signWebhookDelivery` from `./webhook-helpers.js`, which imports
    // `node:crypto`. Even though every frontend import from `@openwop/openwop`
    // is `import type {…}` (no runtime symbols needed), rollup's static
    // analysis pulls the whole barrel including the HMAC helpers, then
    // vite externalizes `node:crypto` and the build dies on unresolved
    // `createHmac` named export. A custom plugin short-circuits the load
    // step for any path ending in `webhook-helpers.js` and returns an
    // empty module — the frontend never executes the HMAC code path.
    plugins: [...distributionPlugin, 
      react(),
      {
        // White-label: stamp the brand document title, favicon, and font
        // stylesheet into index.html at build time from `VITE_BRAND_*`
        // env (falling back to `BRAND_DEFAULTS`). Runs for both `vite dev`
        // and `vite build`. The `{{BRAND_*}}` placeholders in index.html
        // are always replaced, so an un-overridden build renders the
        // stock OpenWOP identity. See `src/brand/defaults.ts`.
        name: 'openwop-brand-html',
        transformIndexHtml: {
          order: 'pre' as const,
          handler(html: string) {
            const brand = resolveBrandFromEnv(loadEnv(mode, __dirname, ''));
            return html
              .replaceAll('{{BRAND_TITLE}}', brand.documentTitle)
              .replaceAll('{{BRAND_FAVICON}}', brand.faviconSrc)
              .replaceAll('{{BRAND_FONTS_HREF}}', brand.fontsHref)
              .replaceAll('{{BRAND_THEME_COLOR}}', brand.themeColor)
              .replaceAll('{{BRAND_DEFAULT_THEME}}', brand.defaultTheme);
          },
        },
        // Emit a brand-stamped PWA manifest at build time (index.html links it
        // via `<link rel="manifest">`). name / theme-color / icon mark all come from
        // `VITE_BRAND_*`, so a fork's `npm run build` ships an installable app
        // with ITS identity — no hand-authored manifest. Build-only: in
        // `vite dev` the manifest link 404s harmlessly (install is a prod concern).
        generateBundle() {
          const brand = resolveBrandFromEnv(loadEnv(mode, __dirname, ''));
          // Icon MIME follows the mark's actual format — a fork pointing
          // VITE_BRAND_MARK_SRC at a PNG must not ship `image/svg+xml`.
          // `sizes: 'any'` is only meaningful for scalable (SVG) icons;
          // raster icons omit it and let the browser read intrinsic size.
          const markExt = (brand.markSrc.split('?')[0].split('.').pop() ?? '').toLowerCase();
          const markType: Record<string, string> = {
            svg: 'image/svg+xml',
            png: 'image/png',
            webp: 'image/webp',
            ico: 'image/x-icon',
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
          };
          const manifest = {
            name: brand.productName,
            short_name: brand.productName,
            description: brand.tagline,
            start_url: '/',
            display: 'standalone',
            background_color: brand.themeColor,
            theme_color: brand.themeColor,
            icons: [{
              src: brand.markSrc,
              ...(markExt === 'svg' ? { sizes: 'any' } : {}),
              ...(markType[markExt] ? { type: markType[markExt] } : {}),
              purpose: 'any',
            }],
          };
          this.emitFile({
            type: 'asset',
            fileName: 'manifest.webmanifest',
            source: JSON.stringify(manifest, null, 2),
          });
          // `brand-info.json` — the RESOLVED identity this build renders, for
          // `scripts/check-branding.sh` (ADR 0630, #3627 instance 3). The check
          // used to grep the bundle for the stock instance name, and that cannot
          // work: `BRAND_DEFAULTS` compiles into the bundle whether or not
          // `VITE_BRAND_*` overrides it (measured: `instanceName:"OpenWOP"` sits
          // beside `instanceName:Ze(Ne.VITE_BRAND_INSTANCE_NAME,…)` in the entry
          // chunk), so "the default string is present" is true of every build,
          // and the only thing the pattern ever matched was prose. Worse, the
          // pattern was `Demo host`, a default retired in #260 — the gate had
          // been asserting a value that could not occur. Emitting the resolved
          // value from the SAME resolver the sidebar renders makes the check
          // deterministic and lets a default change without the check rotting:
          // `isDefault` is computed here against `BRAND_DEFAULTS`, never
          // hard-coded in bash. Every value here is already in the bundle in
          // plain text; nothing new is disclosed.
          const stamped = ['productName', 'instanceName', 'primaryDomain', 'homeUrl', 'documentTitle', 'faviconSrc'] as const;
          this.emitFile({
            type: 'asset',
            fileName: 'brand-info.json',
            source: JSON.stringify({
              ...Object.fromEntries(stamped.map((k) => [k, brand[k]])),
              isDefault: Object.fromEntries(stamped.map((k) => [k, brand[k] === BRAND_DEFAULTS[k]])),
            }, null, 2),
          });
        },
      },
      {
        name: 'openwop-stub-webhook-helpers',
        enforce: 'pre',
        load(id) {
          if (/[/\\]@openwop[/\\]openwop[/\\]dist[/\\]webhook-helpers\.js$/.test(id)) {
            return 'export {};';
          }
          return null;
        },
      },
    ],
    build: {
      outDir: 'dist',
      sourcemap: true,
      // esbuild 0.28 (the #263 security bump) refuses to down-level some modern
      // dependency syntax (destructuring lowering) to vite's legacy default target,
      // breaking the production build. Pin a modern, widely-supported target so no
      // lowering is needed — keeps the esbuild security bump. (Safari 16+/Chrome 94+.)
      target: 'es2022',
      // The AudioWorklet module (RT-8) MUST ship as a real same-origin asset:
      // Vite's small-asset inlining would turn it into a `data:` URL, which
      // `audioWorklet.addModule` loads as a script — and CSP `script-src 'self'`
      // (no `data:`) blocks it in production. Everything else keeps the default.
      assetsInlineLimit: (filePath) => (filePath.endsWith('pcmCaptureWorklet.js') ? false : undefined),
      rollupOptions: {
        output: {
          // Code-split the markdown stack into its own chunk. The chat
          // surface is the only consumer of react-markdown + remark-gfm
          // + their transitive unified/mdast/micromark deps (~250KB
          // minified, ~70KB gzip). Splitting keeps the main bundle
          // under the vite 500KB warning threshold and lets browsers
          // cache the markdown chunk independently of UI churn.
          // Function form so first-party i18n CATALOGS (src/**/i18n/<locale>.ts)
          // join the i18n chunk too — eager-bundled but off the entry critical
          // path (ADR 0065). Keeps the entry lean as catalogs + locales grow.
          manualChunks(id) {
            const n = id.replace(/\\/g, '/');
            if (n.includes('/node_modules/')) {
              if (/\/node_modules\/(i18next|react-i18next|void-elements|html-parse-stringify)\//.test(n)) return 'i18n';
              if (/\/node_modules\/(@firebase|firebase)\//.test(n)) return 'firebase';
              // KaTeX (~70 kB gz) is shared by the chat markdown renderer AND the
              // canvas.document math node (ADR 0334 2b-2) — its own chunk so it
              // neither bloats the markdown chunk past budget nor duplicates.
              if (/\/node_modules\/katex\//.test(n)) return 'katex';
              if (/\/node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|mdast-util-[^/]+|micromark[^/]*|unified|unist-util-[^/]+|hast-util-[^/]+|hastscript|property-information|vfile[^/]*|bail|trough|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities[^/]*|devlop|html-url-attributes|zwitch|longest-streak|ccount|escape-string-regexp|markdown-table|estree-util-[^/]+|web-namespaces|stringify-entities)\//.test(n)) return 'markdown';
              return undefined;
            }
            // LAZY locales (ADR 0329 — every locale except `en`): kept OUT of the eager
            // i18n chunk and grouped into ONE async chunk per locale (`i18n-pt-BR`,
            // `i18n-fr`, `i18n-es`) — loaded only when that locale is negotiated or
            // selected, in a single request (not ~100 per-catalog fetches). They are
            // SUPPORTED (advertised/auto-negotiated) yet still lazy — eager-bundling
            // every locale (~+75 kB gzip each) grows the chunk ~4× faster than any
            // one user needs, so the bundle decision is separate from the
            // SUPPORTED_LOCALES decision. Keep this list in sync with
            // `lazyLocaleGlobs` in src/i18n/resources.ts.
            {
              // ADR 0490 § locale follow-up — a lazy locale's FEATURE catalog is
              // split out of its per-locale chunk exactly as `en`'s are below.
              // Before this, `loadLocaleResources` pulled every catalog for the
              // locale at once, so the three locale chunks (~214–221 kB gzip)
              // became the build's largest assets and a pt-BR user paid for ~90
              // feature catalogs to read one page. The two shell-rendered
              // namespaces stay in the locale chunk for the same reason they stay
              // eager in `en` (they render in the chat feed, which is shell).
              // Keep in sync with SHELL_FEATURE_NAMESPACES in src/i18n/resources.ts
              // — i18nNamespaceSplit.test.ts pins the lists together.
              const lazyFeature = n.match(/\/src\/features\/([^/]+)\/i18n\/(?:pt-BR|fr|es)\.ts$/);
              if (lazyFeature && !['comments', 'cad', 'campaign-studio'].includes(lazyFeature[1]!)) return undefined;
              const lazy = n.match(/\/i18n\/(?:locales\/)?(pt-BR|fr|es)(?:\/|\.ts$)/);
              if (lazy) return `i18n-${lazy[1]}`;
            }
            // ADR 0490 — a LAZY `en` feature catalog must NOT be forced into the
            // eager `i18n` chunk; leaving it unassigned lets Rollup put it in its
            // own async chunk beside the feature page that imports it. Shell
            // catalogs (`src/<area>/i18n/en.ts`, `src/i18n/locales/en/*`) and the
            // three shell-rendered feature namespaces still belong to `i18n`.
            {
              const enFeature = n.match(/\/src\/features\/([^/]+)\/i18n\/en\.ts$/);
              // Keep in sync with SHELL_FEATURE_NAMESPACES in src/i18n/resources.ts
              // (i18nNamespaceSplit.test.ts pins the two lists together).
              if (enFeature && !['comments', 'cad', 'campaign-studio'].includes(enFeature[1]!)) return undefined;
            }
            if (/\/src\/i18n\//.test(n) || /\/i18n\/(en|[a-z]{2}(-[A-Z]{2})?)\.ts$/.test(n)) return 'i18n';
            return undefined;
          },
        },
      },
    },
  };
});
