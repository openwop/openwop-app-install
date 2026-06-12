---
name: browser
description: Static dark-mode + CSS-integrity audit of the OpenWOP app frontend (frontend/react, app.openwop.dev) — the empty-:is() nesting-break fingerprint, hover color-pin traps, third-party-widget (xyflow) theming, hardcoded light fallbacks. There is no headless browser in this environment, so this is a build-time + static audit that ends by naming the surfaces a human must click through in both light and dark.
---

# Browser-Surface Validation — OpenWOP App (`app.openwop.dev`)

The app frontend (`frontend/react/`) has *runtime/visual* bugs — broken dark-mode contrast, off-screen popovers, mis-themed third-party widgets, silently-dropped CSS rules — that `npm run build` and lint do not catch. This skill encodes the failure modes we have actually shipped to `app.openwop.dev` and then fixed one screenshot at a time.

> **Hard constraint: there is no headless browser in this environment.** This is a **static + build-time** audit. Build/lint-green ≠ visually correct — it always ends by naming the surfaces a human must click through, in **both** light and dark.
>
> *(The spec-site validation that used to be "Mode A" of this skill moved to `openwop/openwop-site` with the public site.)*


Source: `frontend/react/` (lone stylesheet: `src/styles/global.css`). Deployed as the Firebase Hosting target `app` (the React SPA) in front of the Cloud Run backend — see `DEPLOY.md` + AGENTS.md's deploy digest.

**Scope split — do not duplicate `/ux-review`.** `/ux-review` Mode A(app) owns *token discipline* against `DESIGN.md` (hex literals, emoji-as-icons, component-registry drift, focus rings). Mode B here owns what ux-review and `openwop:check` **cannot** see: **build-time CSS integrity** and **dark-mode runtime rendering**. These are the bugs we have actually shipped to `app.openwop.dev` and then fixed one screenshot at a time — encode them so the next audit catches them in one pass.

## Step B-1: Build + CSS structural integrity — the empty-`:is()` fingerprint (CRITICAL)

```bash
cd frontend/react
rm -rf dist && npm run build 2>&1 | tail -6           # tsc + vite; must exit 0
CSS=$(ls dist/assets/index-*.css)

# THE check. An empty `:is()` in the BUILT bundle is the unambiguous fingerprint
# of a local CSS nesting break: an unclosed `{` upstream made esbuild's nesting
# transform swallow every following rule as a child and lower the (empty) parent
# to `:is()`, which matches nothing → those rules silently vanish at runtime.
test "$(grep -oE ':is\(\)' "$CSS" | wc -l | tr -d ' ')" = 0 \
  && echo "OK: 0 empty :is()" || echo "FAIL: empty :is() present — a rule block was swallowed"
```

Why this is the canonical detector (and brace-counting is NOT sufficient): a comment/string-aware brace counter reports the *global* balance, but **two defects can cancel** — one missing `}` plus one stray `}` nets to depth 0 and passes the brace check while the file is locally broken and N rules are dropped. That exact pattern shipped past the `#522` brace fix and broke `/keys` (provider badges), then the minimap, then more. **The built-bundle `:is()` count is the reliable signal; run it too:**

```bash
# Necessary but not sufficient — run alongside the :is() check, never instead of it.
python3 - "$PWD/src/styles/global.css" <<'PY'
import sys
s=open(sys.argv[1]).read(); i=0; n=len(s); inb=False; ins=None; stack=[]; line=1; stray=0
while i<n:
    c=s[i]; nx=s[i+1] if i+1<n else ''
    if c=='\n': line+=1
    if inb:
        if c=='*' and nx=='/': inb=False; i+=2; continue
        i+=1; continue
    if ins:
        if c=='\\': i+=2; continue
        if c==ins: ins=None
        i+=1; continue
    if c=='/' and nx=='*': inb=True; i+=2; continue
    if c in '"\'': ins=c; i+=1; continue
    if c=='{': stack.append(line)
    elif c=='}':
        if stack: stack.pop()
        else: stray+=1; print("STRAY } at line", line)
    i+=1
print(f"strays={stray} depth={len(stack)} first_unmatched_open_lines={stack[:10]}")
PY
```

If `:is()` > 0: find the swallowed block (the first `:is()` selector names the first dropped rule), walk *up* to the nearest rule missing its `}`, and recover it verbatim from the pre-break commit (`git show <good-sha>:…/global.css`). NEVER fix a stylesheet with a broad `re.sub(count=0)` — that is what deleted `background:` + `}` from a dozen rules in the first place.

> **Durable fix to recommend:** add `grep -c ':is()' dist/assets/index-*.css` (assert 0) to the `pr-checks.yml` frontend gate so a swallowed-rule regression fails CI instead of shipping. This is the single highest-leverage follow-up — file it.

## Step B-2: Dark-mode hover color-pin trap (HIGH)

The global rule `button:hover { background: var(--clay); color: var(--paper) }` (specificity `0,1,1`) is meant for standalone clay-fill buttons. It **beats** any ghost/menu item that sets its color at `0,1,0` — so on hover the text flips to `--paper` (near-black in dark mode) on a dark hover box → **black-on-black, unreadable**. This hit the account menu and the workflow-card menu.

```bash
cd frontend/react
# Menu/ghost-item :hover rules that set background but NOT color → candidates for the trap.
grep -nE '\.(account-menu|workflow-card-menu|app-nav|.*-menu|.*-item)[^{]*:hover\s*\{' src/styles/global.css
# For each hit, confirm the rule (or the same selector) pins `color:` — a ghost item
# that changes background on hover MUST also pin `color: var(--color-text)` (or
# `var(--color-danger)` for destructive items), mirroring `.account-menu-trigger`.
```

Flag any popover/menu/ghost `:hover` that changes `background` without an explicit `color:`.

## Step B-3: Third-party widget dark theming (HIGH)

Vendored widgets (React Flow / `@xyflow/react` in the builder) ship light-mode defaults that read as glaring white boxes on the dark canvas. Two traps: (a) the widget declares its theming CSS vars on a **deeper** element than yours, shadowing an ancestor override; (b) a direct `fill`/`background` override flattens per-item color.

```bash
cd frontend/react
# MiniMap must be themed AND its node blips colored per-node via the `nodeColor`
# PROP (a CSS `fill` override on `.react-flow__minimap-node` flattens every blip).
grep -nE 'react-flow__minimap|nodeColor|maskColor|MiniMap' src/styles/global.css src/builder/canvas/BuilderCanvas.tsx
# Controls + handles themed?
grep -nE 'react-flow__controls|--xy-(controls|handle|minimap)' src/styles/global.css
```

Verify: minimap `background`/mask are themed via tokens, node color comes from the `nodeColor` prop (not a flat CSS `fill`), and controls/handles use `--xy-*` token overrides. The CAVEAT to state in findings: you cannot confirm the blips actually render without a browser — name it as a human-verify item.

## Step B-4: Hardcoded light fallbacks (MEDIUM)

A literal `#fff` / `white` / light hex used as a `background`/`fill` outside the `:root` and dark-theme override blocks will not flip in dark mode.

```bash
cd frontend/react
# Light backgrounds in the built bundle (resolved) — the dark-theme block lives near the top of global.css.
grep -nE '(background|fill)\s*:\s*(#fff|#ffffff|white)\b' src/styles/global.css
# TSX inline styles with non-token colors (ux-review also flags hex; here we care about light fills specifically).
grep -rnE "style=\{\{[^}]*(background|fill)[^}]*(#fff|white)" src/ | head
```

## Step B-5: Overlay / popover positioning (MEDIUM)

A popover anchored `top: calc(100% + …)` opens **downward**; if its trigger sits at the bottom of the viewport (e.g. the sidebar footer account chip), the menu renders off-screen. Footer-anchored popovers must open upward (`bottom: …`) and, in a left sidebar, extend rightward (`left: 0`, not `right: 0`, so a wide menu doesn't spill off-screen).

```bash
grep -nE '\.[a-z-]*(popover|menu|dropdown|tooltip)[^{]*\{[^}]*position:\s*absolute' src/styles/global.css
# Inspect each: does its trigger live in `.app-sidebar-foot` / a bottom region? If so it must open upward.
```

## Step B-6: Deploy + skew (when shipping a fix)

`app.openwop.dev` is **two** deploys (AGENTS.md): the Cloud Run backend and the Firebase `hosting:app` frontend. A frontend-only redeploy built from `origin/main` drags *other sessions'* merged frontend live; if it calls backend endpoints the running Cloud Run revision lacks → 500/404 skew. Before a frontend deploy, confirm the deployed backend revision is at the same `origin/main` SHA (or newer for the routes the frontend calls).

```bash
( cd frontend/react && npm run build )     # uses .env.production
firebase deploy --only hosting:app --project openwop-dev
# Verify live serves the new bundle + the fix is present (cache-bust the query):
H=$(curl -fsS "https://app.openwop.dev/?cb=$(date +%s)" | grep -oE 'assets/index-[A-Za-z0-9_-]+\.css')
curl -fsS "https://app.openwop.dev/$H?cb=$(date +%s)" | grep -c ':is()'   # expect 0
```

## Step B-7: The human pass (mandatory close-out)

Because there is no headless browser here, Mode B **must** end by handing the user a click-list, in **both** light and dark (toggle in the sidebar footer):

- Sidebar shell + nav hover/active states
- Account menu (open it; hover every item — Sign out + Delete; check off-screen)
- `/keys` provider badges + add-key flow
- Workflow builder: node cards, the **minimap blips**, controls, edges
- DataTables (filters, bulk-select), toasts, skeletons, command palette (⌘K)
- Any card/menu/notice introduced by the change

State plainly: build-green + the static checks above are necessary, not sufficient — these surfaces need eyes.

## Mode B findings format

Same severity list as Step 9. Tag each with `[CSS-INTEGRITY]` / `[DARK-HOVER]` / `[WIDGET-THEME]` / `[LIGHT-FALLBACK]` / `[OVERLAY-POS]` / `[DEPLOY-SKEW]` and cite `global.css:line` or the component.

---

## Workflow Commands

| Command | Action |
|---|---|
| `full` | Run all steps below (app-UI audit) |
| `is-check` | Step 1 — build + assert 0 empty `:is()` + brace balance |
| `dark-hover` | Step 2 — hover color-pin trap scan |
| `widgets` | Step 3 — third-party widget dark theming |
| `light-fallbacks` | Step 4 — hardcoded white/`#fff` background scan |
| `overlays` | Step 5 — popover positioning scan |
| `report` | Generate the findings list |
| `done` | Complete validation |

> The spec-site validation (build/serve/index-parity/links/schemas/previews/registry/landing) moved to the `browser` skill in [`openwop/openwop-site`](https://github.com/openwop/openwop-site).

---

## Related Skills

| Skill | Purpose |
|---|---|
| `/ux-review` | **Token discipline** against `DESIGN.md` for the app (hex literals, emoji-as-icons, component-registry drift, focus rings) — the companion to this skill, which owns build-integrity + dark-mode rendering instead. |
| `/verify` | Run the app to confirm a change works in the real frontend. |
