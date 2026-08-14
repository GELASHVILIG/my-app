import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Article } from '../domain/article.js';
import { AppError } from '../domain/errors.js';
import type { ArticleStore, FeedState, PutArticleResult } from '../domain/ports.js';

/** Item shape and index names are fixed by ADR 0002. */
export const PUBLISHED_AT_INDEX = 'byPublishedAt';
export const ARTICLE_GSI_PARTITION = 'ARTICLE';
export const ARTICLE_TTL_DAYS = 30;
/** Hard ceiling on a page of articles, so no caller can turn the read path into a scan. */
export const MAX_LIST_LIMIT = 100;

const SECONDS_PER_DAY = 24 * 60 * 60;

export class ArticleStoreConfigError extends AppError {
  constructor(message: string) {
    super('ARTICLE_STORE_MISCONFIGURED', message);
  }
}

export function articlePk(id: string): string {
  return `ARTICLE#${id}`;
}

export function feedPk(feedUrl: string): string {
  return `FEED#${feedUrl}`;
}

export function publishedAtSortKey(article: Article): string {
  return `${article.publishedAt}#${article.id}`;
}

function requireString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads come back as `unknown` from the SDK: validate rather than assert, and
 * drop anything that does not look like an article instead of rendering `undefined`.
 */
function toArticle(item: Record<string, unknown>): Article | undefined {
  const id = requireString(item['id']);
  const title = requireString(item['title']);
  const url = requireString(item['url']);
  const source = requireString(item['source']);
  const publishedAt = requireString(item['publishedAt']);
  if (
    id === undefined ||
    title === undefined ||
    url === undefined ||
    source === undefined ||
    publishedAt === undefined
  ) {
    return undefined;
  }
  return { id, title, url, source, publishedAt };
}

function toFeedState(item: Record<string, unknown>): FeedState {
  const etag = requireString(item['etag']);
  const lastModified = requireString(item['lastModified']);
  const lastSeenPublishedAt = requireString(item['lastSeenPublishedAt']);
  const lastSuccessAt = requireString(item['lastSuccessAt']);
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
    ...(lastSeenPublishedAt === undefined ? {} : { lastSeenPublishedAt }),
    ...(lastSuccessAt === undefined ? {} : { lastSuccessAt }),
  };
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIST_LIMIT);
}

export interface DynamoArticleStoreOptions {
  /** Defaults to `process.env.ARTICLES_TABLE_NAME`, injected by the CDK stack. */
  readonly tableName?: string;
  readonly client?: DynamoDBDocumentClient;
  readonly now?: () => Date;
}

function resolveTableName(explicit: string | undefined): string {
  const tableName = explicit ?? process.env['ARTICLES_TABLE_NAME'];
  if (tableName === undefined || tableName === '') {
    throw new ArticleStoreConfigError('ARTICLES_TABLE_NAME is not set');
  }
  return tableName;
}

/**
 * DynamoDB-backed `Articles` table adapter (ADR 0002). Hides the item shape
 * completely: callers see `Article` and `FeedState` only.
 */
export function createDynamoArticleStore(options: DynamoArticleStoreOptions = {}): ArticleStore {
  const tableName = resolveTableName(options.tableName);
  const client =
    options.client ??
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  const now = options.now ?? ((): Date => new Date());

  return {
    async putArticleIfAbsent(article: Article): Promise<PutArticleResult> {
      const fetchedAt = now();
      const ttl = Math.floor(fetchedAt.getTime() / 1000) + ARTICLE_TTL_DAYS * SECONDS_PER_DAY;
      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: {
              pk: articlePk(article.id),
              gsiPk: ARTICLE_GSI_PARTITION,
              gsiSk: publishedAtSortKey(article),
              id: article.id,
              title: article.title,
              url: article.url,
              source: article.source,
              publishedAt: article.publishedAt,
              fetchedAt: fetchedAt.toISOString(),
              ttl,
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          }),
        );
        return 'inserted';
      } catch (error) {
        // The conditional put is the dedup mechanism, so a failed condition is
        // an expected outcome rather than an error.
        if (error instanceof ConditionalCheckFailedException) return 'duplicate';
        throw error;
      }
    },

    async listRecentArticles(limit: number): Promise<Article[]> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: PUBLISHED_AT_INDEX,
          KeyConditionExpression: 'gsiPk = :gsiPk',
          ExpressionAttributeValues: { ':gsiPk': ARTICLE_GSI_PARTITION },
          ScanIndexForward: false,
          Limit: clampLimit(limit),
        }),
      );
      return (result.Items ?? [])
        .map((item) => toArticle(item))
        .filter((article): article is Article => article !== undefined);
    },

    async getFeedState(feedUrl: string): Promise<FeedState | undefined> {
      const result = await client.send(
        new GetCommand({ TableName: tableName, Key: { pk: feedPk(feedUrl) } }),
      );
      return result.Item === undefined ? undefined : toFeedState(result.Item);
    },

    async putFeedState(feedUrl: string, state: FeedState): Promise<void> {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: feedPk(feedUrl),
            ...(state.etag === undefined ? {} : { etag: state.etag }),
            ...(state.lastModified === undefined ? {} : { lastModified: state.lastModified }),
            ...(state.lastSeenPublishedAt === undefined
              ? {}
              : { lastSeenPublishedAt: state.lastSeenPublishedAt }),
            ...(state.lastSuccessAt === undefined ? {} : { lastSuccessAt: state.lastSuccessAt }),
          },
        }),
      );
    },
  };
}
