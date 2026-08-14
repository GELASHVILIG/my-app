import { AppError } from '../domain/errors.js';
import type { ConditionalGetHeaders, FeedFetchResult } from '../domain/ports.js';

/** Per-feed fetch budget (ADR 0003). */
export const FEED_FETCH_TIMEOUT_MS = 5000;
/** One misconfigured feed must not exhaust Lambda memory (ADR 0003). */
export const MAX_FEED_BYTES = 5 * 1024 * 1024;
/**
 * Feeds are third-party infrastructure we do not pay for; an anonymous poller is
 * the kind of thing that gets blocked without notice (ADR 0003).
 */
export const FEED_USER_AGENT =
  'my-app-news-aggregator/1.0 (+https://github.com/GELASHVILIG/my-app)';

export class FeedFetchError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super('FEED_FETCH_FAILED', message, options);
  }
}

function conditionalHeaders(conditional: ConditionalGetHeaders): Record<string, string> {
  return {
    ...(conditional.etag === undefined ? {} : { 'if-none-match': conditional.etag }),
    ...(conditional.lastModified === undefined
      ? {}
      : { 'if-modified-since': conditional.lastModified }),
  };
}

/** Streams the body, aborting as soon as it goes over the size guard. */
async function readBounded(response: Response, url: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FEED_BYTES) {
    throw new FeedFetchError(`feed body declares ${String(declaredLength)} bytes: ${url}`);
  }

  // `Response.body` is typed as `ReadableStream<any>` by the runtime types; pin
  // the chunk type so the size arithmetic below stays type-safe.
  const body: ReadableStream<Uint8Array> | null = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';

  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_FEED_BYTES) {
        throw new FeedFetchError(`feed body exceeded ${String(MAX_FEED_BYTES)} bytes: ${url}`);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}

/**
 * HTTP GET a feed with a timeout, a size guard and conditional-GET support.
 *
 * Redirects are followed: feed URLs come from a checked-in config file
 * (`src/config/feeds.ts`), never from user input, so this is not an SSRF surface.
 *
 * @throws {FeedFetchError} on a non-200/304 status, a transport failure, a
 * timeout, or an oversized body. The ingest service isolates this per feed.
 */
export async function fetchFeed(
  url: string,
  conditional: ConditionalGetHeaders = {},
): Promise<FeedFetchResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
        'user-agent': FEED_USER_AGENT,
        ...conditionalHeaders(conditional),
      },
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FeedFetchError(`feed request failed: ${url}`, { cause: error });
  }

  if (response.status === 304) return { status: 'not-modified' };

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FeedFetchError(`feed responded ${String(response.status)}: ${url}`);
  }

  const body = await readBounded(response, url);
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');

  return {
    status: 'ok',
    body,
    ...(etag === null ? {} : { etag }),
    ...(lastModified === null ? {} : { lastModified }),
  };
}
