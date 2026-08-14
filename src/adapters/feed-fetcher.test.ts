import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_USER_AGENT,
  FeedFetchError,
  MAX_FEED_BYTES,
  fetchFeed,
} from './feed-fetcher.js';

const FEED_URL = 'https://example.com/rss';

function stubFetch(response: Response): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

function lastRequestInit(): RequestInit {
  const spy = vi.mocked(globalThis.fetch);
  const init = spy.mock.calls[0]?.[1];
  if (init === undefined) throw new Error('fetch was not called with an init object');
  return init;
}

function headersOf(init: RequestInit): Record<string, string> {
  return new Headers(init.headers).entries().reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key] = value;
    return acc;
  }, {});
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetchFeed', () => {
  it('returns the body plus the caching validators on 200', async () => {
    stubFetch(
      new Response('<rss/>', {
        status: 200,
        headers: { etag: 'W/"abc"', 'last-modified': 'Tue, 12 Aug 2026 09:00:00 GMT' },
      }),
    );

    await expect(fetchFeed(FEED_URL)).resolves.toEqual({
      status: 'ok',
      body: '<rss/>',
      etag: 'W/"abc"',
      lastModified: 'Tue, 12 Aug 2026 09:00:00 GMT',
    });
  });

  it('omits validators the response did not send', async () => {
    stubFetch(new Response('<rss/>', { status: 200 }));

    await expect(fetchFeed(FEED_URL)).resolves.toEqual({ status: 'ok', body: '<rss/>' });
  });

  it('sends an identifying user agent and a timeout signal', async () => {
    stubFetch(new Response('<rss/>', { status: 200 }));

    await fetchFeed(FEED_URL);

    const init = lastRequestInit();
    expect(headersOf(init)['user-agent']).toBe(FEED_USER_AGENT);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends conditional-GET headers when prior validators are known', async () => {
    stubFetch(new Response(null, { status: 304 }));

    await fetchFeed(FEED_URL, { etag: 'W/"abc"', lastModified: 'Tue, 12 Aug 2026 09:00:00 GMT' });

    const headers = headersOf(lastRequestInit());
    expect(headers['if-none-match']).toBe('W/"abc"');
    expect(headers['if-modified-since']).toBe('Tue, 12 Aug 2026 09:00:00 GMT');
  });

  it('sends no conditional headers on a first fetch', async () => {
    stubFetch(new Response('<rss/>', { status: 200 }));

    await fetchFeed(FEED_URL);

    const headers = headersOf(lastRequestInit());
    expect(headers['if-none-match']).toBeUndefined();
    expect(headers['if-modified-since']).toBeUndefined();
  });

  it('reports 304 as not-modified rather than an empty body', async () => {
    stubFetch(new Response(null, { status: 304 }));

    await expect(fetchFeed(FEED_URL)).resolves.toEqual({ status: 'not-modified' });
  });

  it('throws on a non-200 status', async () => {
    stubFetch(new Response('nope', { status: 500 }));

    await expect(fetchFeed(FEED_URL)).rejects.toBeInstanceOf(FeedFetchError);
  });

  it('throws when the declared content length exceeds the guard', async () => {
    stubFetch(
      new Response('<rss/>', {
        status: 200,
        headers: { 'content-length': String(MAX_FEED_BYTES + 1) },
      }),
    );

    await expect(fetchFeed(FEED_URL)).rejects.toThrow(/declares/);
  });

  it('aborts a body that streams past the guard', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 10) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
    });
    stubFetch(new Response(body, { status: 200 }));

    await expect(fetchFeed(FEED_URL)).rejects.toThrow(/exceeded/);
  });

  it('wraps a transport failure in a FeedFetchError with the cause attached', async () => {
    const cause = new Error('socket hang up');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(cause);

    await expect(fetchFeed(FEED_URL)).rejects.toMatchObject({
      code: 'FEED_FETCH_FAILED',
      cause,
    });
  });
});
