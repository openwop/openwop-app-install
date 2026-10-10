/**
 * ADR 0762 — the front page's intro film is hosted by openwop.dev. A pixel-
 * compared run must not depend on that network (the same lesson as
 * `serveFontsLocally`: six webfont NetworkError flakes), so the poster is
 * served from a committed copy. The MP4 itself is never requested: the video
 * is `preload="none"` and nothing presses play. The captions track is not
 * enabled by default, so its request 404s harmlessly if made. Any other openwop.dev media
 * request fails fast and deterministically instead of hanging on the network.
 */
import type { Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POSTER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'film', 'openwop-intro-poster.jpg');

export async function serveFilmLocally(page: Page): Promise<void> {
  const poster = await fs.readFile(POSTER);
  await page.route('https://openwop.dev/assets/video/**', (route) => {
    const name = path.basename(new URL(route.request().url()).pathname);
    // The <video> is crossOrigin="anonymous" (for its captions track), so its
    // poster is a CORS request too; answer with the header openwop.dev sends.
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'openwop-intro-poster.jpg') return route.fulfill({ status: 200, contentType: 'image/jpeg', headers: cors, body: poster });
    return route.fulfill({ status: 404, headers: cors, body: '' });
  });
}
