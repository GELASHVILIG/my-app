import type { Article } from '../domain/article.js';
import type { ArticleStore, FeedState, PutArticleResult } from '../domain/ports.js';

/**
 * Process-local `ArticleStore`. Used by `npm run dev` so the local server needs
 * no AWS credentials or deployed table, and by tests that want a real store
 * rather than a stub. Deliberately not used by either Lambda handler.
 */
export function createInMemoryArticleStore(seed: readonly Article[] = []): ArticleStore {
  const articles = new Map<string, Article>(seed.map((article) => [article.id, article]));
  const feedState = new Map<string, FeedState>();

  return {
    putArticleIfAbsent(article: Article): Promise<PutArticleResult> {
      if (articles.has(article.id)) return Promise.resolve('duplicate');
      articles.set(article.id, article);
      return Promise.resolve('inserted');
    },

    listRecentArticles(limit: number): Promise<Article[]> {
      const sorted = [...articles.values()].sort((a, b) => {
        if (a.publishedAt === b.publishedAt) return a.id < b.id ? 1 : -1;
        return a.publishedAt < b.publishedAt ? 1 : -1;
      });
      return Promise.resolve(sorted.slice(0, Math.max(0, Math.trunc(limit))));
    },

    getFeedState(feedUrl: string): Promise<FeedState | undefined> {
      return Promise.resolve(feedState.get(feedUrl));
    },

    putFeedState(feedUrl: string, state: FeedState): Promise<void> {
      feedState.set(feedUrl, state);
      return Promise.resolve();
    },
  };
}
