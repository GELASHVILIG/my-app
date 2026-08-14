import { afterEach, describe, expect, it } from 'vitest';
import { createInMemoryArticleStore } from './adapters/in-memory-article-store.js';
import type { Article } from './domain/article.js';
import { createDevServer } from './index.js';

const article: Article = {
  id: 'a1',
  title: 'Hello world',
  url: 'https://example.com/hello',
  source: 'example.com',
  publishedAt: '2026-08-13T09:05:00.000Z',
};

let close: (() => Promise<void>) | undefined;

async function startServer(articles: readonly Article[]): Promise<string> {
  const server = createDevServer(createInMemoryArticleStore(articles));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('dev server did not bind to a TCP port');
  }
  return `http://127.0.0.1:${String(address.port)}`;
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

describe('createDevServer', () => {
  it('serves the article list page on GET /', async () => {
    const baseUrl = await startServer([article]);

    const response = await fetch(`${baseUrl}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.text()).toContain('Hello world');
  });

  it('serves 404 for any other path', async () => {
    const baseUrl = await startServer([article]);

    const response = await fetch(`${baseUrl}/not-a-page`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Hello world');
  });

  it('ignores the query string when routing', async () => {
    const baseUrl = await startServer([article]);

    const response = await fetch(`${baseUrl}/?utm_source=test`);

    expect(response.status).toBe(200);
  });
});
