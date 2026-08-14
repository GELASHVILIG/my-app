import { describeError } from '../domain/errors.js';
import { parseFeed } from '../domain/feed-parser.js';
import type { ArticleWriter, FeedFetcher, FeedState } from '../domain/ports.js';

/** Concurrent feed fetches per cycle (ADR 0003). */
export const FEED_CONCURRENCY = 6;

export interface AggregateSummary {
  /** Feeds attempted. */
  readonly feeds: number;
  /** Feeds that returned a fresh body. */
  readonly fetched: number;
  /** Feeds that answered 304 Not Modified — success with no work. */
  readonly notModified: number;
  /** Feeds that failed and were skipped. */
  readonly failed: number;
  /** Articles newly written. */
  readonly inserted: number;
  /** Articles skipped: the conditional put found them already stored. */
  readonly skipped: number;
}

export interface AggregateFeedsDeps {
  readonly store: ArticleWriter;
  readonly fetchFeed: FeedFetcher;
  readonly now?: () => Date;
}

interface FeedOutcome {
  readonly fetched: number;
  readonly notModified: number;
  readonly inserted: number;
  readonly skipped: number;
}

const NO_WORK: FeedOutcome = { fetched: 0, notModified: 1, inserted: 0, skipped: 0 };

/** Runs `worker` over `items`, never more than `limit` at a time. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const queue = [...items.entries()];
  const results: PromiseSettledResult<R>[] = [];
  let next = 0;

  async function runNext(): Promise<void> {
    for (;;) {
      const entry = queue[next++];
      if (entry === undefined) return;
      const [index, item] = entry;
      try {
        results[index] = { status: 'fulfilled', value: await worker(item) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, () => runNext()));
  return results;
}

/**
 * M1 has no per-feed display name, so the source shown on the page is the feed's
 * host. Replacing this with a configured name is part of the M2 feed list.
 */
function sourceNameFromUrl(feedUrl: string): string {
  try {
    return new URL(feedUrl).host.replace(/^www\./, '');
  } catch {
    return feedUrl;
  }
}

function maxIso(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

async function ingestFeed(feedUrl: string, deps: AggregateFeedsDeps): Promise<FeedOutcome> {
  const now = deps.now ?? ((): Date => new Date());
  const previous = await deps.store.getFeedState(feedUrl);

  const response = await deps.fetchFeed(feedUrl, {
    ...(previous?.etag === undefined ? {} : { etag: previous.etag }),
    ...(previous?.lastModified === undefined ? {} : { lastModified: previous.lastModified }),
  });

  if (response.status === 'not-modified') {
    await deps.store.putFeedState(feedUrl, { ...previous, lastSuccessAt: now().toISOString() });
    return NO_WORK;
  }

  const articles = parseFeed(response.body, sourceNameFromUrl(feedUrl));

  if (articles.length === 0) {
    // parseFeed never throws, so malformed XML and an unrecognised root element
    // both arrive here as zero articles. Without this line a feed serving
    // garbage looks identical to a feed with nothing new (ADR 0003).
    console.warn(JSON.stringify({ event: 'feed.parse.empty', feedUrl, articleCount: 0 }));
  }

  let inserted = 0;
  let skipped = 0;
  let newWatermark = previous?.lastSeenPublishedAt;

  for (const article of articles) {
    newWatermark = maxIso(newWatermark, article.publishedAt);
    // Nothing is skipped on publish time: ranked feeds such as Hacker News'
    // front page surface stories long after their submission time, so a
    // watermark would drop them permanently. Dedup is the conditional put's job
    // (`attribute_not_exists(pk)`, ADR 0002), which is idempotent by construction.
    const result = await deps.store.putArticleIfAbsent(article);
    if (result === 'inserted') inserted += 1;
    else skipped += 1;
  }

  const state: FeedState = {
    ...(response.etag === undefined ? {} : { etag: response.etag }),
    ...(response.lastModified === undefined ? {} : { lastModified: response.lastModified }),
    ...(newWatermark === undefined ? {} : { lastSeenPublishedAt: newWatermark }),
    lastSuccessAt: now().toISOString(),
  };
  await deps.store.putFeedState(feedUrl, state);

  return { fetched: 1, notModified: 0, inserted, skipped };
}

/**
 * Fetch, parse, dedup and store every feed in one cycle.
 *
 * Failures are isolated per feed: a feed that is down, slow, or serving garbage
 * is logged as `feed.fetch.failed` and skipped, and the rest still land
 * (ADR 0003). Never throws for a feed-level failure.
 */
export async function aggregateFeeds(
  feedUrls: readonly string[],
  deps: AggregateFeedsDeps,
): Promise<AggregateSummary> {
  const settled = await mapWithConcurrency(feedUrls, FEED_CONCURRENCY, async (feedUrl) => {
    try {
      return await ingestFeed(feedUrl, deps);
    } catch (error) {
      // The only structured signal that a source has quietly died (ADR 0003).
      console.error(
        JSON.stringify({ event: 'feed.fetch.failed', feedUrl, ...describeError(error) }),
      );
      throw error;
    }
  });

  const summary = { fetched: 0, notModified: 0, failed: 0, inserted: 0, skipped: 0 };
  for (const result of settled) {
    if (result.status === 'rejected') {
      summary.failed += 1;
      continue;
    }
    summary.fetched += result.value.fetched;
    summary.notModified += result.value.notModified;
    summary.inserted += result.value.inserted;
    summary.skipped += result.value.skipped;
  }

  return { feeds: feedUrls.length, ...summary };
}
