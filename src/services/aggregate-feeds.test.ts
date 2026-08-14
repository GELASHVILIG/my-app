import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../domain/article.js';
import type {
  ArticleWriter,
  FeedFetchResult,
  FeedState,
  PutArticleResult,
} from '../domain/ports.js';
import { articleId, normalizeUrl } from '../domain/url.js';
import { FEED_CONCURRENCY, aggregateFeeds } from './aggregate-feeds.js';

const NOW = new Date('2026-08-14T12:00:00.000Z');

function rss(items: readonly { title: string; link: string; pubDate: string }[]): string {
  const body = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><pubDate>${item.pubDate}</pubDate></item>`,
    )
    .join('');
  return `<rss version="2.0"><channel>${body}</channel></rss>`;
}

const FEED_A = 'https://a.example.com/rss';
const FEED_B = 'https://www.b.example.com/rss';

const BODY_A = rss([
  { title: 'A one', link: 'https://a.example.com/one', pubDate: 'Tue, 12 Aug 2026 09:00:00 GMT' },
  { title: 'A two', link: 'https://a.example.com/two', pubDate: 'Wed, 13 Aug 2026 09:00:00 GMT' },
]);
const BODY_B = rss([
  { title: 'B one', link: 'https://b.example.com/one', pubDate: 'Tue, 12 Aug 2026 10:00:00 GMT' },
]);

interface FakeStore extends ArticleWriter {
  readonly puts: Article[];
  readonly feedState: Map<string, FeedState>;
}

function fakeStore(options: { existingIds?: readonly string[]; state?: Record<string, FeedState> } = {}): FakeStore {
  const stored = new Set(options.existingIds ?? []);
  const feedState = new Map<string, FeedState>(Object.entries(options.state ?? {}));
  const puts: Article[] = [];

  return {
    puts,
    feedState,
    putArticleIfAbsent(article: Article): Promise<PutArticleResult> {
      puts.push(article);
      if (stored.has(article.id)) return Promise.resolve('duplicate');
      stored.add(article.id);
      return Promise.resolve('inserted');
    },
    getFeedState(feedUrl: string): Promise<FeedState | undefined> {
      return Promise.resolve(feedState.get(feedUrl));
    },
    putFeedState(feedUrl: string, state: FeedState): Promise<void> {
      feedState.set(feedUrl, state);
      return Promise.resolve();
    },
  };
}

function fetcherFor(bodies: Record<string, FeedFetchResult | Error>) {
  return (url: string): Promise<FeedFetchResult> => {
    const result = bodies[url];
    if (result === undefined) return Promise.reject(new Error(`unexpected feed ${url}`));
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('aggregateFeeds', () => {
  it('stores every article from every feed', async () => {
    const store = fakeStore();

    const summary = await aggregateFeeds([FEED_A, FEED_B], {
      store,
      fetchFeed: fetcherFor({
        [FEED_A]: { status: 'ok', body: BODY_A },
        [FEED_B]: { status: 'ok', body: BODY_B },
      }),
      now: () => NOW,
    });

    expect(summary).toEqual({
      feeds: 2,
      fetched: 2,
      notModified: 0,
      failed: 0,
      inserted: 3,
      skipped: 0,
    });
  });

  it('labels articles with the feed host as the source', async () => {
    const store = fakeStore();

    await aggregateFeeds([FEED_B], {
      store,
      fetchFeed: fetcherFor({ [FEED_B]: { status: 'ok', body: BODY_B } }),
      now: () => NOW,
    });

    expect(store.puts[0]?.source).toBe('b.example.com');
  });

  it('keeps a failing feed from taking down the others and logs it', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = fakeStore();

    const summary = await aggregateFeeds([FEED_A, FEED_B], {
      store,
      fetchFeed: fetcherFor({
        [FEED_A]: new Error('connect ECONNREFUSED'),
        [FEED_B]: { status: 'ok', body: BODY_B },
      }),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ feeds: 2, fetched: 1, failed: 1, inserted: 1 });
    expect(store.puts.map((a) => a.title)).toEqual(['B one']);

    const logged: unknown = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged).toEqual({
      event: 'feed.fetch.failed',
      feedUrl: FEED_A,
      errorClass: 'Error',
      message: 'connect ECONNREFUSED',
    });
  });

  it('does not count a duplicate article as inserted', async () => {
    const store = fakeStore({
      existingIds: [articleId(normalizeUrl('https://a.example.com/one'))],
    });

    const first = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body: BODY_A } }),
      now: () => NOW,
    });
    expect(first).toMatchObject({ inserted: 1, skipped: 1 });

    // Second cycle: everything is already stored, so nothing counts as inserted.
    const second = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body: BODY_A } }),
      now: () => NOW,
    });
    expect(second).toMatchObject({ inserted: 0, skipped: 2 });
  });

  it('treats 304 as success with no work', async () => {
    const store = fakeStore({ state: { [FEED_A]: { etag: 'W/"1"' } } });

    const summary = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'not-modified' } }),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ fetched: 0, notModified: 1, inserted: 0, failed: 0 });
    expect(store.puts).toEqual([]);
    expect(store.feedState.get(FEED_A)).toEqual({
      etag: 'W/"1"',
      lastSuccessAt: NOW.toISOString(),
    });
  });

  it('sends the stored validators back on the next fetch', async () => {
    const store = fakeStore();
    const fetchFeed = vi.fn(() =>
      Promise.resolve<FeedFetchResult>({
        status: 'ok',
        body: BODY_A,
        etag: 'W/"7"',
        lastModified: 'Wed, 13 Aug 2026 09:00:00 GMT',
      }),
    );

    await aggregateFeeds([FEED_A], { store, fetchFeed, now: () => NOW });
    expect(fetchFeed).toHaveBeenLastCalledWith(FEED_A, {});
    expect(store.feedState.get(FEED_A)).toEqual({
      etag: 'W/"7"',
      lastModified: 'Wed, 13 Aug 2026 09:00:00 GMT',
      lastSeenPublishedAt: '2026-08-13T09:00:00.000Z',
      lastSuccessAt: NOW.toISOString(),
    });

    await aggregateFeeds([FEED_A], { store, fetchFeed, now: () => NOW });
    expect(fetchFeed).toHaveBeenLastCalledWith(FEED_A, {
      etag: 'W/"7"',
      lastModified: 'Wed, 13 Aug 2026 09:00:00 GMT',
    });
  });

  // Regression: a ranked feed (Hacker News' front page) surfaces stories long
  // after their submission time, so skipping on publishedAt dropped them for good.
  it('stores an article older than the stored watermark', async () => {
    const store = fakeStore({
      state: { [FEED_A]: { lastSeenPublishedAt: '2026-08-13T09:00:00.000Z' } },
    });

    const summary = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body: BODY_A } }),
      now: () => NOW,
    });

    expect(store.puts.map((a) => a.title)).toEqual(['A one', 'A two']);
    expect(summary).toMatchObject({ inserted: 2, skipped: 0 });
  });

  it('does not double-count two items that normalize to the same url', async () => {
    const store = fakeStore();
    const body = rss([
      {
        title: 'Same story',
        link: 'https://a.example.com/one?utm_source=hn',
        pubDate: 'Tue, 12 Aug 2026 09:00:00 GMT',
      },
      {
        title: 'Same story, reposted',
        link: 'https://a.example.com/one?ref=twitter',
        pubDate: 'Wed, 13 Aug 2026 09:00:00 GMT',
      },
    ]);

    const summary = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body } }),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ inserted: 1, skipped: 1 });
  });

  it('logs a structured event when a fetched feed parses to zero articles', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = fakeStore();

    const summary = await aggregateFeeds([FEED_A], {
      store,
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body: '<rss><channel>truncated' } }),
      now: () => NOW,
    });

    expect(summary).toMatchObject({ fetched: 1, failed: 0, inserted: 0, skipped: 0 });

    const logged: unknown = JSON.parse(String(warnSpy.mock.calls[0]?.[0]));
    expect(logged).toEqual({ event: 'feed.parse.empty', feedUrl: FEED_A, articleCount: 0 });
  });

  it('does not log feed.parse.empty when the feed yields articles', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await aggregateFeeds([FEED_A], {
      store: fakeStore(),
      fetchFeed: fetcherFor({ [FEED_A]: { status: 'ok', body: BODY_A } }),
      now: () => NOW,
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('never runs more than the concurrency cap at once', async () => {
    const store = fakeStore();
    const feeds = Array.from({ length: 20 }, (_, i) => `https://f${String(i)}.example.com/rss`);
    let inFlight = 0;
    let peak = 0;

    const summary = await aggregateFeeds(feeds, {
      store,
      now: () => NOW,
      fetchFeed: async (): Promise<FeedFetchResult> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return { status: 'ok', body: BODY_B };
      },
    });

    expect(peak).toBeLessThanOrEqual(FEED_CONCURRENCY);
    expect(summary.fetched).toBe(20);
  });

  it('handles an empty feed list', async () => {
    await expect(
      aggregateFeeds([], { store: fakeStore(), fetchFeed: fetcherFor({}), now: () => NOW }),
    ).resolves.toEqual({
      feeds: 0,
      fetched: 0,
      notModified: 0,
      failed: 0,
      inserted: 0,
      skipped: 0,
    });
  });
});
