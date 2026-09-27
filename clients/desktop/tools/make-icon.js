// ADR 0181 — generate `build/icon.png` (1024×1024) from the brand mark
// configured in `branding.json` (`iconSvg`, stock = the SPA's own
// `frontend/react/public/OpenWOP.svg`), so the desktop icon can never drift
// from the product brand. Rendered by Electron itself (offscreen) — no image
// libraries, no external fetches. electron-builder picks up `build/icon.png`
// automatically and derives the platform formats (icns/ico).
//
//   npx electron tools/make-icon.js
'use strict';

const { app, BrowserWindow, nativeTheme } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { readBranding } = require('../src/branding.js');

const BRANDING = readBranding(path.join(__dirname, '..', 'branding.json'));
// `iconSvg` is relative to clients/desktop/ (absolute paths pass through).
const SVG_PATH = path.resolve(path.join(__dirname, '..'), BRANDING.iconSvg);
const OUT_PATH = path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 512; const OUT_SIZE = 1024;

// macOS iconography: artwork carries its own rounded-square; the plate tone
// (`branding.iconPlate`, stock = the SVG's dark-mode ink #f4f1ea) must keep
// the mark legible on it.
function iconHtml(svgMarkup) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${SIZE}px;height:${SIZE}px;background:transparent;overflow:hidden}
    .plate{position:absolute;inset:${Math.round(SIZE * 0.05)}px;background:${BRANDING.iconPlate};border-radius:${Math.round(SIZE * 0.2)}px;
      display:grid;place-items:center;box-shadow:inset 0 0 0 ${Math.round(SIZE * 0.008)}px rgba(0,0,0,0.06)}
    svg{width:${Math.round(SIZE * 0.68)}px;height:${Math.round(SIZE * 0.68)}px}
  </style></head><body><div class="plate">${svgMarkup}</div></body></html>`;
}

app.whenReady().then(async () => {
  try {
    const svg = readFileSync(SVG_PATH, 'utf8');
    const win = new BrowserWindow({
      width: SIZE, height: SIZE, show: true, frame: false,
      webPreferences: { sandbox: true },
    });
    nativeTheme.themeSource = 'light'; // never let dark-scheme ink overrides fire
    // (paper-colored strokes) never fires — the plate is already paper.
    
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(iconHtml(svg))}`);
    await new Promise((res) => setTimeout(res, 400)); // let it paint
    const captured = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    const image = captured.resize({ width: OUT_SIZE, height: OUT_SIZE });
    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, image.toPNG());
    console.log(`[make-icon] wrote ${OUT_PATH} (${image.getSize().width}x${image.getSize().height})`);
    app.exit(0);
  } catch (err) {
    console.error('[make-icon] failed:', err instanceof Error ? err.message : String(err));
    app.exit(1);
  }
});
