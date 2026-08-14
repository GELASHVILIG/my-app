import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Article } from '../domain/article.js';
import {
  ARTICLE_GSI_PARTITION,
  ARTICLE_TTL_DAYS,
  ArticleStoreConfigError,
  MAX_LIST_LIMIT,
  PUBLISHED_AT_INDEX,
  createDynamoArticleStore,
} from './dynamo-article-store.js';

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = 'Articles-test';
const FETCHED_AT = new Date('2026-08-14T12:00:00.000Z');

const article: Article = {
  id: 'a1',
  title: 'Hello',
  url: 'https://example.com/hello',
  source: 'Example',
  publishedAt: '2026-08-14T09:00:00.000Z',
};

function store(): ReturnType<typeof createDynamoArticleStore> {
  return createDynamoArticleStore({
    tableName: TABLE,
    client: DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' })),
    now: () => FETCHED_AT,
  });
}

beforeEach(() => {
  ddb.reset();
});

afterEach(() => {
  delete process.env['ARTICLES_TABLE_NAME'];
});

describe('createDynamoArticleStore', () => {
  it('reads the table name from the environment when not given one', () => {
    expect(() => createDynamoArticleStore()).toThrow(ArticleStoreConfigError);
    process.env['ARTICLES_TABLE_NAME'] = TABLE;
    expect(() => createDynamoArticleStore()).not.toThrow();
  });
});

describe('putArticleIfAbsent', () => {
  it('writes the ADR 0002 item shape with a conditional put', async () => {
    ddb.on(PutCommand).resolves({});

    await expect(store().putArticleIfAbsent(article)).resolves.toBe('inserted');

    const input = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.TableName).toBe(TABLE);
    expect(input?.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(input?.Item).toEqual({
      pk: 'ARTICLE#a1',
      gsiPk: ARTICLE_GSI_PARTITION,
      gsiSk: '2026-08-14T09:00:00.000Z#a1',
      id: 'a1',
      title: 'Hello',
      url: 'https://example.com/hello',
      source: 'Example',
      publishedAt: '2026-08-14T09:00:00.000Z',
      fetchedAt: FETCHED_AT.toISOString(),
      ttl: Math.floor(FETCHED_AT.getTime() / 1000) + ARTICLE_TTL_DAYS * 24 * 60 * 60,
    });
  });

  it('reports a failed condition as a duplicate rather than throwing', async () => {
    ddb
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ $metadata: {}, message: 'exists' }));

    await expect(store().putArticleIfAbsent(article)).resolves.toBe('duplicate');
  });

  it('propagates any other DynamoDB failure', async () => {
    ddb.on(PutCommand).rejects(new Error('throttled'));

    await expect(store().putArticleIfAbsent(article)).rejects.toThrow('throttled');
  });
});

describe('listRecentArticles', () => {
  it('queries the recency index newest-first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ ...article }] });

    await expect(store().listRecentArticles(50)).resolves.toEqual([article]);

    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.IndexName).toBe(PUBLISHED_AT_INDEX);
    expect(input?.KeyConditionExpression).toBe('gsiPk = :gsiPk');
    expect(input?.ExpressionAttributeValues).toEqual({ ':gsiPk': ARTICLE_GSI_PARTITION });
    expect(input?.ScanIndexForward).toBe(false);
    expect(input?.Limit).toBe(50);
  });

  it('clamps the requested limit', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    await store().listRecentArticles(10_000);
    await store().listRecentArticles(0);

    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.Limit).toBe(MAX_LIST_LIMIT);
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.Limit).toBe(1);
  });

  it('drops items that are not shaped like an article', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ ...article }, { pk: 'ARTICLE#x', id: 'x' }] });

    await expect(store().listRecentArticles(50)).resolves.toEqual([article]);
  });

  it('handles a response with no items', async () => {
    ddb.on(QueryCommand).resolves({});

    await expect(store().listRecentArticles(50)).resolves.toEqual([]);
  });
});

describe('feed state', () => {
  it('reads a FEED# item', async () => {
    ddb.on(GetCommand).resolves({
      Item: { pk: 'FEED#https://example.com/rss', etag: 'W/"1"', lastSeenPublishedAt: 'x' },
    });

    await expect(store().getFeedState('https://example.com/rss')).resolves.toEqual({
      etag: 'W/"1"',
      lastSeenPublishedAt: 'x',
    });
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input.Key).toEqual({
      pk: 'FEED#https://example.com/rss',
    });
  });

  it('returns undefined when the feed has never been fetched', async () => {
    ddb.on(GetCommand).resolves({});

    await expect(store().getFeedState('https://example.com/rss')).resolves.toBeUndefined();
  });

  it('writes only the attributes it has', async () => {
    ddb.on(PutCommand).resolves({});

    await store().putFeedState('https://example.com/rss', { etag: 'W/"2"' });

    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item).toEqual({
      pk: 'FEED#https://example.com/rss',
      etag: 'W/"2"',
    });
  });
});
