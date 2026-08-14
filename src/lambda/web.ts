import { createDynamoArticleStore } from '../adapters/dynamo-article-store.js';
import type { ArticleReader } from '../domain/ports.js';
import { handleRequest } from '../http/handler.js';

/**
 * Thin shim over `src/http` for the web Lambda (ADR 0001: the handler stays an
 * adapter with no logic in it).
 *
 * The event and result types are the structural subset of API Gateway HTTP API
 * v2's `APIGatewayProxyEventV2` / `APIGatewayProxyStructuredResultV2` that this
 * handler actually reads, declared locally to keep `@types/aws-lambda` out of
 * the dependency tree.
 */
export interface ApiGatewayProxyEventV2 {
  readonly rawPath: string;
  readonly requestContext: { readonly http: { readonly method: string } };
}

export interface ApiGatewayProxyStructuredResultV2 {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly isBase64Encoded: boolean;
}

export type WebHandler = (
  event: ApiGatewayProxyEventV2,
) => Promise<ApiGatewayProxyStructuredResultV2>;

export function createWebHandler(store: ArticleReader): WebHandler {
  return async (event) => {
    const response = await handleRequest(
      { method: event.requestContext.http.method, path: event.rawPath },
      { store },
    );
    return { ...response, isBase64Encoded: false };
  };
}

let cachedHandler: WebHandler | undefined;

/** Built lazily so the store is reused across invocations but importing stays side-effect free. */
export const handler: WebHandler = (event) => {
  cachedHandler ??= createWebHandler(createDynamoArticleStore());
  return cachedHandler(event);
};
