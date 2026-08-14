import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryArticleStore } from '../adapters/in-memory-article-store.js';
import type { FeedFetchResult } from '../domain/ports.js';
import { createIngestHandler } from './ingest.js';

const FEED_URL = 'https://feed.example.com/rss';
const BODY = `<rss version="2.0"><channel><item><title>One</title><link>https://example.com/one</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item></channel></rss>`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createIngestHandler', () => {
  it('runs a cycle and reports what it did', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = createInMemoryArticleStore();

    const summary = await createIngestHandler({
      store,
      feedUrls: [FEED_URL],
      fetchFeed: (): Promise<FeedFetchResult> => Promise.resolve({ status: 'ok', body: BODY }),
    })();

    expect(summary).toMatchObject({ feeds: 1, fetched: 1, inserted: 1, failed: 0 });
    await expect(store.listRecentArticles(10)).resolves.toHaveLength(1);

    const logged: unknown = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    expect(logged).toMatchObject({ event: 'feed.ingest.completed', inserted: 1 });
  });

  it('does not throw when every feed fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const summary = await createIngestHandler({
      store: createInMemoryArticleStore(),
      feedUrls: [FEED_URL],
      fetchFeed: () => Promise.reject(new Error('gone')),
    })();

    expect(summary).toMatchObject({ failed: 1, inserted: 0 });
  });
});
