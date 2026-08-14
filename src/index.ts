import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { fetchFeed } from './adapters/feed-fetcher.js';
import { createInMemoryArticleStore } from './adapters/in-memory-article-store.js';
import { FEED_URLS } from './config/feeds.js';
import { describeError } from './domain/errors.js';
import type { ArticleStore } from './domain/ports.js';
import { handleRequest } from './http/handler.js';
import { aggregateFeeds } from './services/aggregate-feeds.js';

export const DEFAULT_PORT = 3000;

/**
 * Local dev server. Deliberately backed by the in-memory store rather than
 * DynamoDB: `npm run dev` then needs no AWS credentials and no deployed table,
 * and the production wiring lives in `src/lambda/*` where it belongs.
 */
export function createDevServer(store: ArticleStore): Server {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname;
    handleRequest({ method: request.method ?? 'GET', path }, { store })
      .then((result) => {
        response.writeHead(result.statusCode, result.headers);
        response.end(result.body);
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ event: 'dev.request.failed', ...describeError(error) }));
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('internal error');
      });
  });
}

function resolvePort(): number {
  const port = Number(process.env['PORT'] ?? DEFAULT_PORT);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : DEFAULT_PORT;
}

/** Fills the in-memory store once at startup, then serves it. Restart to refresh. */
export async function main(): Promise<void> {
  const store = createInMemoryArticleStore();
  const summary = await aggregateFeeds(FEED_URLS, { store, fetchFeed });
  console.log(JSON.stringify({ event: 'dev.ingest.completed', ...summary }));

  const port = resolvePort();
  createDevServer(store).listen(port, () => {
    console.log(JSON.stringify({ event: 'dev.listening', url: `http://localhost:${String(port)}` }));
  });
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  await main();
}
