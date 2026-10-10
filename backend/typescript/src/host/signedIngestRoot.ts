/**
 * ADR 0793 / RFC 0230 — the credential-less, signature-authenticated inbound-webhook
 * ingest root: a version-agnostic vendor path (ADR 0652). Its own module so the auth
 * layer and the body-parser mount can name it without importing the ingestion
 * service (and the executor graph behind it).
 */
export const SIGNED_INGEST_ROOT = '/host/openwop-app/trigger-ingest';
