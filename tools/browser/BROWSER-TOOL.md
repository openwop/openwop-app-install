# Browser Validation Tool

A headless Chromium browser controlled via a Playwright CLI wrapper. Built for Claude Code to validate UI rendering, test navigation flows, and verify tutorial content directly in the browser.

## Architecture

```
browse.sh (CLI)  ──HTTP POST──>  server.mjs (Node.js)  ──Playwright──>  Chromium
     │                                  │
     │  reads .browser-state.json       │  writes .browser-state.json
     │  for port + auth token           │  on startup (port, token, pid)
     └──────────────────────────────────┘
```

Three components work together:

### 1. `browse.sh` — CLI Entry Point

A thin bash wrapper that acts as the single interface for all browser commands.

**What it does on each invocation:**

1. Checks if a server is already running by reading `.browser-state.json` and hitting the `/health` endpoint
2. If running, sends the command as an HTTP POST body to `http://127.0.0.1:{port}/command` with a Bearer token
3. If not running, starts `server.mjs` as a background process (`nohup`), waits up to 15 seconds for it to become healthy, then sends the command
4. On the very first run, checks if Playwright's Chromium binary is installed and runs `npx playwright install chromium` if needed

**Key implementation details:**

- Uses `$*` to forward all arguments as a single string (the server parses it)
- Reads state via `node -p "JSON.parse(...)"` since `jq` may not be installed
- Server logs go to `.browser-server.log` for debugging cold-start failures
- All output to stderr (`>&2`) for status messages; only command results go to stdout

### 2. `server.mjs` — Persistent Playwright Server

A Node.js HTTP server that keeps Chromium alive between commands. This is the core of the tool — it manages the browser lifecycle, routes commands, and maintains element references.

**Lifecycle:**

- Starts on a random available port (`listen(0, '127.0.0.1')`) — localhost only for security
- Generates a UUID v4 auth token via `crypto.randomUUID()`
- Writes `{ pid, port, token, startedAt }` to `.browser-state.json`
- Launches Chromium lazily on first navigation command (not at startup)
- Auto-shuts down after 30 minutes of idle time (configurable via `BROWSE_IDLE_TIMEOUT` env var)
- On crash: the `browser.on('disconnected')` handler exits the process; `browse.sh` auto-restarts on the next invocation

**HTTP API:**

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/health` | GET | None | Liveness check — returns `ok` |
| `/command` | POST | Bearer token | Executes a command from the text body |

**Browser management:**

- Uses a single `BrowserContext` with a default 1280x720 viewport and HTTPS error tolerance
- Maintains a `Map<tabId, Page>` for multi-tab support
- Each page gets console message capture (ring buffer of 200 entries) and auto-accept dialog handling
- The `stopping` flag prevents the disconnect handler from racing the intentional shutdown path

**Command parsing:**

The `parseCommandString()` function tokenizes the POST body with quote awareness:

```
"fill @e3 Hello world"   →  command: "fill",  args: ["@e3", "Hello", "world"]
'goto "http://example.com"'  →  command: "goto",  args: ["http://example.com"]
```

Quotes only delimit tokens at token boundaries — single quotes mid-word (like `querySelector('a')`) are preserved as literal characters. This was a deliberate fix: the original parser treated all quotes as delimiters, which broke JavaScript expressions passed via `eval`.

**Error wrapping:**

All errors are rewritten to be actionable for an AI agent:

| Condition | Response |
|-----------|----------|
| Browser binary missing | Suggests `npx playwright install chromium` |
| Element not found | Suggests `snapshot -i` to list elements |
| Timeout | Reports what timed out |
| Stale ref | Suggests re-running `snapshot` |

### 3. `snapshot.mjs` — ARIA Snapshot Parser

Parses the YAML-like output of Playwright's `locator.ariaSnapshot()` and annotates each element with a `@ref` ID that can be used in subsequent commands.

**How Playwright's ARIA snapshot works:**

Playwright walks the page's accessibility tree (not the DOM) and produces a text representation:

```yaml
- navigation "Main":
  - link "Home"
  - link "About"
- main:
  - heading "Welcome" [level=1]
  - paragraph: Some text here
  - button "Submit"
  - textbox "Email"
```

Each line has: indentation (tree depth), `- ` prefix, ARIA role, optional name in quotes, optional attributes in brackets, optional text after colon.

**What the parser does:**

1. Iterates through lines, parsing role and name from each
2. Skips structural-only roles (`document`, `generic`, `none`, `presentation`)
3. In `-i` (interactive) mode, only assigns refs to widget roles: `button`, `link`, `textbox`, `checkbox`, `radio`, `combobox`, `menuitem`, `tab`, `switch`, `slider`, `spinbutton`, `searchbox`, `option`, `menu`, `listbox`, `dialog`
4. Tracks occurrence count per `role::name` pair to handle duplicates (e.g., two buttons named "Delete" get `nthIndex` 0 and 1)
5. Assigns sequential IDs: `@e1`, `@e2`, `@e3`, ...
6. Appends `  <- @eN` to annotated lines

**How refs map back to Playwright locators:**

```javascript
// ref = { role: 'button', name: 'Submit', nthIndex: 0 }
let locator = page.getByRole('button', { name: 'Submit' });
if (ref.nthIndex > 0) locator = locator.nth(ref.nthIndex);
```

This uses Playwright's accessibility-based locators rather than CSS selectors or XPath. Benefits:
- Works with any framework (React, Vue, vanilla)
- No DOM injection — safe with strict CSP
- Resilient to class name changes and DOM restructuring
- Mirrors how assistive technology sees the page

**Staleness detection:**

When a ref is used (e.g., `click @e3`), the server calls `locator.count()` first. If 0 elements match, it throws a stale error suggesting the user re-run `snapshot`.

## State Files

| File | Purpose | Git-ignored |
|------|---------|-------------|
| `.browser-state.json` | Server connection info (port, token, PID) | Yes |
| `.browser-server.log` | Server stdout/stderr for debugging | Yes (matched by `*.log`) |
| `.browser-screenshots/` | Screenshot and PDF output directory | Yes |

## Command Reference

### Navigation

| Command | Description |
|---------|-------------|
| `goto <url>` | Navigate to URL. Waits for `domcontentloaded`. Returns status code and page title. |
| `back` | Browser back button |
| `forward` | Browser forward button |
| `reload` | Reload current page |

### Reading

| Command | Description |
|---------|-------------|
| `snapshot` | Full ARIA tree of the page with `@ref` annotations |
| `snapshot -i` | Only interactive elements (buttons, links, inputs, etc.) |
| `snapshot -s "selector"` | Scope snapshot to a CSS selector (e.g., `"main"`, `".sidebar"`) |
| `text` | Full page text content |
| `text @ref` | Text content of a specific element |
| `html` | Full page inner HTML |
| `html @ref` | Inner HTML of a specific element |
| `title` | Page title |
| `url` | Current URL |
| `links` | All links on the page (text + href) |
| `eval <js>` | Execute JavaScript and return the result |
| `console` | Last 50 console messages captured from the page |

### Interaction

| Command | Description |
|---------|-------------|
| `click @ref` | Click an element by ref |
| `click "selector"` | Click by CSS selector (fallback) |
| `fill @ref <text>` | Clear and fill an input. Remaining args are joined with spaces. |
| `select @ref <value>` | Select a dropdown option |
| `hover @ref` | Hover over an element |
| `type <text>` | Type text via keyboard (doesn't target a specific element) |
| `press <key>` | Press a keyboard key (`Enter`, `Tab`, `Escape`, `ArrowDown`, etc.) |
| `check @ref` | Check a checkbox |
| `uncheck @ref` | Uncheck a checkbox |
| `scroll [direction] [px]` | Scroll the page. Direction: `down` (default), `up`, `left`, `right`. Default 500px. |
| `wait <ms>` | Wait for a duration |
| `wait <selector>` | Wait for a CSS selector to appear (30s timeout) |

### Visual

| Command | Description |
|---------|-------------|
| `screenshot` | Save screenshot to `.browser-screenshots/` |
| `screenshot <path>` | Save screenshot to a specific path |
| `screenshot --full` | Full-page screenshot (scrolls) |
| `screenshot @ref <path>` | Screenshot a specific element |
| `pdf [path]` | Generate PDF (A4 format) |
| `viewport <width> <height>` | Resize the browser viewport |

### Tabs

| Command | Description |
|---------|-------------|
| `tabs` | List all tabs with URLs. Active tab marked with `*`. |
| `tab <id>` | Switch to a tab by ID |
| `newtab [url]` | Open a new tab, optionally navigating to a URL |
| `closetab` | Close the active tab |

### Server

| Command | Description |
|---------|-------------|
| `status` | Show browser connection state, tab count, active URL, ref count |
| `stop` | Shut down the browser and server. State file is cleaned up. |

## Claude Code Skill

The `/browser` skill (`.claude/commands/browser.md`) teaches Claude how to use the tool. It sets up the `$B` alias and provides workflows for:

- Tutorial validation (structure, links, content)
- Form testing (fill, submit, verify)
- Responsive testing (viewport changes + screenshots)
- Console error checking
- Multi-page navigation

Invoke with `/browser <task description>`, e.g., `/browser validate the campaign studio tutorial`.

## Prerequisites

- **Node.js v22+** (already installed)
- **Playwright v1.49+** with Chromium (already installed as `@playwright/test@1.57.0`)
- Chromium browser binary: auto-installed on first run via `npx playwright install chromium`

## Extending

**Adding a new command:**

1. Write an `async function cmdMyCommand(args)` in `server.mjs`
2. Add it to the `COMMANDS` map
3. Update the usage text in `browse.sh`
4. Update the command reference in `.claude/commands/browser.md`

**Changing idle timeout:**

```bash
BROWSE_IDLE_TIMEOUT=3600000 ./tools/browser/browse.sh goto "http://localhost:5173"
```

**Debugging:**

- Server logs: `cat .browser-server.log`
- Check if server is running: `./tools/browser/browse.sh status`
- Kill a stuck server: read PID from `.browser-state.json`, then `kill <pid>`

## Known Limitations & Workarounds

### Shell Escaping with `!` Character

The `browse.sh` wrapper uses `CMD="$*"` which can corrupt `!` in passwords or text (bash history expansion). **Workaround:** Use direct `curl` to the server:

```bash
STATE_FILE="$(git rev-parse --show-toplevel)/.browser-state.json"
PORT=$(node -p "JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).port")
TOKEN=$(node -p "JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).token")
curl -s --max-time 30 -X POST "http://127.0.0.1:$PORT/command" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: text/plain" \
  -d 'fill @e3 !Test@ccounT1'
```

### Server Restart Loses Authentication

Restarting the server creates a new Chromium instance with no session cookies. Log in again after any restart. Avoid restarting mid-test.

### Playwright's Single-Quoted ARIA Lines

Playwright wraps ARIA snapshot lines containing special characters (colons in names) in single quotes. The snapshot parser handles this — `'button "Blank Page: Start with an empty canvas"':` is parsed correctly as role=`button`, name=`Blank Page: Start with an empty canvas`.

### Exact Name Matching

The server uses `{ exact: true }` for `getByRole` name matching. Without this, "Password" would match both "Password" and "Confirm Password" fields. The `@ref` name must exactly match the element's ARIA accessible name.
