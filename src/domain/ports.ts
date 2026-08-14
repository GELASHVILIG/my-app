import type { Article } from './article.js';

/**
 * Ports the outside world plugs into. Declared here so `src/services` and
 * `src/http` depend on the domain rather than on an adapter (ADR 0002: the
 * adapter layer must hide DynamoDB's item shape completely).
 */

/** Per-feed state driving conditional GET (ADR 0003). */
export interface FeedState {
  readonly etag?: string;
  readonly lastModified?: string;
  /**
   * ISO-8601 UTC publish time of the newest item seen on the last successful
   * cycle. Recorded for diagnostics only: nothing is skipped on it, because
   * ranked feeds publish out of order (ADR 0003, "Correction, M1").
   */
  readonly lastSeenPublishedAt?: string;
  readonly lastSuccessAt?: string;
}

export type PutArticleResult = 'inserted' | 'duplicate';

/** Read side of the article store — all `src/http` needs. */
export interface ArticleReader {
  listRecentArticles(limit: number): Promise<Article[]>;
}

/** Write side of the article store — all the ingest service needs. */
export interface ArticleWriter {
  putArticleIfAbsent(article: Article): Promise<PutArticleResult>;
  getFeedState(feedUrl: string): Promise<FeedState | undefined>;
  putFeedState(feedUrl: string, state: FeedState): Promise<void>;
}

export interface ArticleStore extends ArticleReader, ArticleWriter {}

export interface ConditionalGetHeaders {
  readonly etag?: string;
  readonly lastModified?: string;
}

export type FeedFetchResult =
  | { readonly status: 'not-modified' }
  | {
      readonly status: 'ok';
      readonly body: string;
      readonly etag?: string;
      readonly lastModified?: string;
    };

export type FeedFetcher = (
  url: string,
  conditional?: ConditionalGetHeaders,
) => Promise<FeedFetchResult>;
