# shellcheck shell=bash
# Is a Playwright browser cache present? Mirrors Playwright's own lookup:
# PLAYWRIGHT_BROWSERS_PATH, when set (and not "0", which means "inside
# node_modules"), is the ONLY place Playwright looks, so it is the only place
# checked; otherwise the per-OS default cache. The remote gate VM keeps its
# browsers in a persistent PLAYWRIGHT_BROWSERS_PATH under a per-job HOME, and the
# HOME-only check called them missing (ADR 0863 D9 shadow 6, 2026-11-02).
playwright_browsers_present() {
  local p="${PLAYWRIGHT_BROWSERS_PATH:-}"
  if [ -n "$p" ] && [ "$p" != 0 ]; then
    [ -d "$p" ] && [ -n "$(ls -A "$p" 2>/dev/null)" ]
    return
  fi
  [ -d "$HOME/Library/Caches/ms-playwright" ] || [ -d "$HOME/.cache/ms-playwright" ]
}
