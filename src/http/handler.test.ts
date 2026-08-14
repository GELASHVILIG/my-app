import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Article } from '../domain/article.js';
import type { ArticleReader } from '../domain/ports.js';
import { PAGE_SIZE, handleRequest } from './handler.js';

const article: Article = {
  id: 'a1',
  title: 'Hello world',
  url: 'https://example.com/hello',
  source: 'example.com',
  publishedAt: '2026-08-13T09:05:00.000Z',
};

function stubStore(articles: readonly Article[]): ArticleReader {
  return { listRecentArticles: () => Promise.resolve([...articles]) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('handleRequest', () => {
  it('renders the article list on GET /', async () => {
    const response = await handleRequest({ method: 'GET', path: '/' }, { store: stubStore([article]) });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Hello world');
    expect(response.body).toContain('https://example.com/hello');
  });

  it('asks the store for one page of articles', async () => {
    const listRecentArticles = vi.fn(() => Promise.resolve([]));

    await handleRequest({ method: 'GET', path: '/' }, { store: { listRecentArticles } });

    expect(listRecentArticles).toHaveBeenCalledWith(PAGE_SIZE);
  });

  it('sets the caching and security headers required by ADR 0001 and 0004', async () => {
    const response = await handleRequest({ method: 'GET', path: '/' }, { store: stubStore([]) });

    expect(response.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
  });

  it.each([
    ['GET', '/favicon.ico'],
    ['GET', '/stats'],
    ['POST', '/'],
    ['DELETE', '/'],
  ])('returns 404 for %s %s', async (method, path) => {
    const response = await handleRequest({ method, path }, { store: stubStore([article]) });

    expect(response.statusCode).toBe(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('Hello world');
  });

  it('turns a store failure into a 503 without leaking detail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store: ArticleReader = {
      listRecentArticles: () => Promise.reject(new Error('ProvisionedThroughputExceeded')),
    };

    const response = await handleRequest({ method: 'GET', path: '/' }, { store });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('ProvisionedThroughputExceeded');
    expect(response.headers['cache-control']).toBe('no-store');

    const logged: unknown = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(logged).toEqual({
      event: 'page.render.failed',
      errorClass: 'Error',
      message: 'ProvisionedThroughputExceeded',
    });
  });
});
