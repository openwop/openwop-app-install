/**
 * ADR 0812 P3a — the SCOPED body parsers: larger limits for upload families, and
 * raw-body capture for every signed inbound webhook.
 *
 * Moved out of `index.ts` so they can be mounted on a bare app and TESTED
 * (`test/adr0812-p3a-canonical-matchers.test.ts`). Every mount is the unversioned
 * path, the only spelling that reaches a route (ADR 0812). A parser keyed on any
 * other spelling would silently stop matching, the global 1mb parser would win, a
 * provider signature over the raw body would fail closed, and money events would
 * be dropped.
 *
 * Call BEFORE the global `express.json({ limit: '1mb' })`: body-parser is a no-op
 * once `req._body` is set, so registration order is precedence order.
 */
import express, { type Express } from 'express';
import { SIGNED_INGEST_ROOT } from '../host/signedIngestRoot.js';

export function mountScopedBodyParsers(app: Express): void {
  // Higher-limit JSON parser for packs/* publish payloads. MUST
  // register before the global 1mb parser; body-parser is no-op when
  // req._body is set, so registration order is precedence order.
  app.use('/packs', express.json({ limit: '50mb' }));
  // Chat-attachment uploads (base64) ride a scoped parser sized to the
  // 8mb-base64 store cap in routes/mediaAssets.ts. Registered before the
  // global 1mb parser; body-parser is a no-op once req._body is set, so
  // registration order is precedence order.
  app.use('/host/openwop-app/media', express.json({ limit: '12mb' }));
  // ADR 0334 4b-3 — DOCX import carries a base64 .docx (~10mb cap enforced in the
  // route); the default 1mb parser would reject it. Scoped to document-editor so
  // the larger limit doesn't widen every route.
  app.use('/host/openwop-app/document-editor', express.json({ limit: '12mb' }));
  // Inbound provider webhooks (ADR 0024 §6) need the EXACT raw bytes to verify a
  // provider HMAC, so this scoped parser stashes them on `req.rawBody` before the
  // global parser consumes the stream. Registered first; body-parser no-ops once
  // req._body is set, so this wins for the inbound prefix.
  app.use('/host/openwop-app/connections-inbound', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // ADR 0394 — Twilio (WhatsApp BSP) delivers `application/x-www-form-urlencoded`,
  // which the json parser above skips; same raw-bytes capture, same prefix.
  app.use('/host/openwop-app/connections-inbound', express.urlencoded({
    extended: false,
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // App-builder inbound sync webhook (ADR 0393 Phase 2) — GitHub signs the EXACT
  // raw body (X-Hub-Signature-256), so it needs the same raw-bytes capture.
  // 1mb: a push payload carries a commits[] array (GitHub truncates at 2048,
  // we only read head_commit/ref/after, but the envelope must parse).
  app.use('/host/openwop-app/app-builder-sync/webhook', express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // ADR 0793 / RFC 0230 — the signed inbound-webhook ingest verifies a Standard
  // Webhooks signature over the EXACT raw bytes, of any content type, so capture
  // them raw. 1mb matches the ingestion body cap (maxBodyBytes).
  app.use(SIGNED_INGEST_ROOT, express.raw({
    type: () => true,
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Stripe billing webhook (ADR 0176) — Stripe signs the EXACT raw body, so it needs
  // the same raw-bytes capture. Scoped to the public webhook path only.
  app.use('/host/openwop-app/billing/webhook', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Commerce Stripe webhook (ADR 0177 deferred P3) — same raw-body capture.
  app.use('/host/openwop-app/commerce/webhook', express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Email bounce/complaint webhook (ADR 0241) — the provider (SendGrid/Postmark)
  // signs the EXACT raw body, so capture it before the global parser. 2mb bounds
  // a provider event batch (the route also caps event count).
  app.use('/host/openwop-app/public-email/events', express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as import('express').Request).rawBody = Buffer.from(buf);
    },
  }));
  // Notebooks audio/video SOURCE upload (ADR 0085) carries base64-encoded media
  // up to the ~32 MiB decoded transcription cap. 32 MiB decoded is ≈ 42.7 MB of
  // base64, so the body limit is 48mb — comfortably above the cap so the route's
  // own decoded-size 413 guard is REACHABLE (not co-incident with this parser
  // limit, the way an under-sized cap becomes dead code). Scoped to the
  // `/sources/audio` sub-route only — every other notebook route keeps the small
  // global limit. Registered before the global parser; body-parser no-ops once
  // req._body is set, so registration order is precedence order.
  const notebooksAudioJson = express.json({ limit: '48mb' });
  app.use('/host/openwop-app/notebooks', (req, res, next) =>
    req.method === 'POST' && /\/sources\/audio$/.test(req.path) ? notebooksAudioJson(req, res, next) : next(),
  );
  // KB FILE UPLOAD (text/PDF/DOCX → extracted text): document/source-ingest POSTs
  // carry base64 file bytes up to the ~32 MiB decoded ingest cap (≈42.7 MB base64),
  // so they get the same 48mb parser as audio. Scoped to the ingest endpoints only
  // (paths ending `/documents` or `/sources`); every other route keeps the 1mb
  // global limit. Registered before the global parser (body-parser no-ops once
  // req._body is set, so order = precedence).
  const fileUploadJson = express.json({ limit: '48mb' });
  app.use('/host/openwop-app', (req, res, next) =>
    req.method === 'POST' && /\/(documents|sources)$/.test(req.path) ? fileUploadJson(req, res, next) : next(),
  );
  // CDP-G batch/CSV import (ADR 0298) — a CSV body up to the route's 10k-row hard
  // cap can exceed the 1mb global limit, which would 413 BEFORE the cap is reached
  // (making the cap dead code). An 8mb parser keeps the row-count cap the binding
  // guard. Scoped to the single import route; registered before the global parser
  // (body-parser no-ops once req._body is set, so order = precedence).
  app.use('/host/openwop-app/cdp/collect/import', express.json({ limit: '8mb' }));
  // Canvas editor docs (ADR 0333 grade pass DATA-D1/CODE-D2) — the drawing
  // schema legally holds far more than 1mb (2000 shapes × 600-point spines);
  // ~60 full ink strokes crosses the global limit and every save 413s BEFORE
  // the schema cap binds, stranding unsaved work. An 8mb parser on the canvas
  // editor families keeps the schema the binding guard. Scoped + registered
  // before the global parser (body-parser no-ops once req._body is set).
  app.use([
    '/host/openwop-app/drawings',
    '/host/openwop-app/cad',
    '/host/openwop-app/slides',
    '/host/openwop-app/campaign-studio',
    '/host/openwop-app/app-builder',
    '/host/openwop-app/canvas-packs',
  ], express.json({ limit: '8mb' }));
}
