import { describeError } from '../domain/errors.js';
import type { ArticleReader } from '../domain/ports.js';
import { renderArticleListPage, renderMessagePage } from './render.js';

/** Articles shown on the home page (ADR 0002: `Query` the GSI with `Limit: 50`). */
export const PAGE_SIZE = 50;

export interface HttpRequest {
  readonly method: string;
  readonly path: string;
}

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export interface HandleRequestDeps {
  readonly store: ArticleReader;
}

/** ADR 0004. `default-src 'none'` means injected script cannot run even if escaping fails. */
const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:;",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

function html(statusCode: number, body: string, cacheControl: string): HttpResponse {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'cache-control': cacheControl },
    body,
  };
}

/**
 * The whole web surface for v1, framework-agnostic so the Lambda handler stays a
 * thin translation shim (ADR 0001).
 *
 * This is the boundary: a store failure becomes a 503 with a static body and a
 * structured log line, never a stack trace in the response (ADR 0001 failure
 * design).
 */
export async function handleRequest(
  request: HttpRequest,
  deps: HandleRequestDeps,
): Promise<HttpResponse> {
  if (request.method !== 'GET' || request.path !== '/') {
    return html(404, renderMessagePage('Not found', 'There is nothing at this address.'), 'no-store');
  }

  try {
    const articles = await deps.store.listRecentArticles(PAGE_SIZE);
    // ADR 0001: cheap, helps browsers, and makes a future CDN a config change.
    return html(200, renderArticleListPage(articles), 'public, max-age=300');
  } catch (error) {
    console.error(JSON.stringify({ event: 'page.render.failed', ...describeError(error) }));
    return html(
      503,
      renderMessagePage('Temporarily unavailable', 'Please try again in a few minutes.'),
      'no-store',
    );
  }
}
