/**
 * ADR 1015 D2 — the API base the public visitor modules call (consent lane,
 * beacons, heat and replay capture).
 *
 * The SPA uses its build-time base (`VITE_OPENWOP_BASE_URL`, e.g. `/api`). The
 * tenant site runtime on a customer's custom domain calls the SAME hostname, so it
 * sets `''`. Kept here, dependency-free, so those modules never import
 * `client/config` (which pulls the SPA's session and brand code onto customer
 * hosts).
 */
import { DEV_FALLBACK_BASE_URL } from '../../client/baseUrlDefault';

let base: string = (import.meta.env.VITE_OPENWOP_BASE_URL as string | undefined) ?? DEV_FALLBACK_BASE_URL;

export function visitorApiBase(): string { return base; }

/** Set once at boot by the site runtime. */
export function setVisitorApiBase(next: string): void { base = next; }
