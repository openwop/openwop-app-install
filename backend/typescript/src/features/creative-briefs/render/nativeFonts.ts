/** ADR 0399 CB-RENDER-1 — native resvg accepts fontFiles, not WASM fontBuffers.
 * Keep exact resolved bytes private for one synchronous render operation. A GIF
 * holds this scope across all frames; no cross-tenant or process-global cache. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResvgRenderOptions } from '@resvg/resvg-js';
import { BUNDLED_FONT_FAMILIES } from './fonts.js';

type NativeFontOptions = NonNullable<ResvgRenderOptions['font']>;

/** The callback must finish native rendering and copy its result synchronously.
 * The producer already owns font validation, tenant checks and byte limits. */
export function withNativeFontFiles<T>(fonts: readonly Buffer[], render: (font: NativeFontOptions) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'openwop-ad-fonts-'));
  try {
    chmodSync(directory, 0o700);
    const fontFiles = fonts.map((bytes, index) => {
      const filename = join(directory, `${index}.ttf`);
      writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
      return filename;
    });
    return render({ loadSystemFonts: false, fontFiles, defaultFontFamily: BUNDLED_FONT_FAMILIES.sans });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
