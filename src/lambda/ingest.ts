import { createDynamoArticleStore } from '../adapters/dynamo-article-store.js';
import { fetchFeed } from '../adapters/feed-fetcher.js';
import { FEED_URLS } from '../config/feeds.js';
import type { ArticleWriter, FeedFetcher } from '../domain/ports.js';
import type { AggregateSummary } from '../services/aggregate-feeds.js';
import { aggregateFeeds } from '../services/aggregate-feeds.js';

/**
 * Thin shim over `src/services` for the scheduled ingest Lambda (ADR 0003).
 * The EventBridge scheduled event carries nothing this job needs.
 */
export type IngestHandler = () => Promise<AggregateSummary>;

export interface IngestDeps {
  readonly store: ArticleWriter;
  readonly fetchFeed: FeedFetcher;
  readonly feedUrls: readonly string[];
}

export function createIngestHandler(deps: IngestDeps): IngestHandler {
  return async () => {
    const summary = await aggregateFeeds(deps.feedUrls, {
      store: deps.store,
      fetchFeed: deps.fetchFeed,
    });
    console.log(JSON.stringify({ event: 'feed.ingest.completed', ...summary }));
    return summary;
  };
}

let cachedHandler: IngestHandler | undefined;

export const handler: IngestHandler = () => {
  cachedHandler ??= createIngestHandler({
    store: createDynamoArticleStore(),
    fetchFeed,
    feedUrls: FEED_URLS,
  });
  return cachedHandler();
};
