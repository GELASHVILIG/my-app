import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * A URL that cannot take part in article identity (unparseable, or a scheme we
 * refuse to render as an outbound link).
 */
export class InvalidUrlError extends AppError {
  constructor(url: string, reason: string, options?: ErrorOptions) {
    super('INVALID_URL', `invalid url (${reason}): ${url}`, options);
  }
}

/** Query parameters dropped wholesale during normalization (ADR 0002). */
const TRACKING_PARAMS: ReadonlySet<string> = new Set(['ref', 'source', 'fbclid', 'gclid']);
const TRACKING_PARAM_PREFIX = 'utm_';

function isTrackingParam(key: string): boolean {
  return key.startsWith(TRACKING_PARAM_PREFIX) || TRACKING_PARAMS.has(key);
}

function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Canonical URL form used to derive article identity. Fixed by ADR 0002 —
 * changing it changes every future article id, so it is a deliberate, visible act.
 *
 * Rules, in order: lowercase scheme and host; drop the default port (80/443);
 * drop the fragment; drop tracking parameters (`utm_*`, `ref`, `source`,
 * `fbclid`, `gclid`); sort the remaining parameters by key; strip exactly one
 * trailing slash from the path. Path case is preserved.
 *
 * @throws {InvalidUrlError} if the input is unparseable or not http(s). Callers
 * at the ingest boundary skip such items rather than failing the run.
 */
export function normalizeUrl(url: string): string {
  let parsed: URL;
  try {
    // The WHATWG parser already lowercases the scheme and host and removes the
    // default port for http/https.
    parsed = new URL(url);
  } catch (error) {
    throw new InvalidUrlError(url, 'unparseable', { cause: error });
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new InvalidUrlError(url, `unsupported scheme ${parsed.protocol}`);
  }

  const params = [...parsed.searchParams.entries()].filter(([key]) => !isTrackingParam(key));
  params.sort(([a], [b]) => byCodePoint(a, b));
  const search = new URLSearchParams(params).toString();

  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;

  return `${parsed.protocol}//${parsed.host}${path}${search === '' ? '' : `?${search}`}`;
}

/** Dedup key for an article: lowercase hex SHA-256 of its normalized URL (ADR 0002). */
export function articleId(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl, 'utf8').digest('hex');
}
