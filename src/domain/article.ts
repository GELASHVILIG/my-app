/**
 * A single aggregated article.
 *
 * `id` is the dedup key: the SHA-256 of the normalized `url` (see `articleId`).
 * `url` is always the normalized form, so two feeds carrying the same story with
 * different tracking parameters produce one article.
 * `publishedAt` is ISO-8601 in UTC, which makes lexicographic ordering the same
 * as chronological ordering (relied on by the DynamoDB GSI sort key).
 */
export interface Article {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly source: string;
  readonly publishedAt: string;
}
