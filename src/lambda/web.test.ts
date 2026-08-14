import { describe, expect, it } from 'vitest';
import type { Article } from '../domain/article.js';
import type { ArticleReader } from '../domain/ports.js';
import type { ApiGatewayProxyEventV2 } from './web.js';
import { createWebHandler } from './web.js';

const article: Article = {
  id: 'a1',
  title: 'Hello world',
  url: 'https://example.com/hello',
  source: 'example.com',
  publishedAt: '2026-08-13T09:05:00.000Z',
};

const store: ArticleReader = { listRecentArticles: () => Promise.resolve([article]) };

function event(method: string, rawPath: string): ApiGatewayProxyEventV2 {
  return { rawPath, requestContext: { http: { method } } };
}

describe('createWebHandler', () => {
  it('translates an HTTP API v2 event into the rendered page', async () => {
    const result = await createWebHandler(store)(event('GET', '/'));

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(false);
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(result.body).toContain('Hello world');
  });

  it('passes an unknown route through to the 404 response', async () => {
    const result = await createWebHandler(store)(event('GET', '/nope'));

    expect(result.statusCode).toBe(404);
  });
});
