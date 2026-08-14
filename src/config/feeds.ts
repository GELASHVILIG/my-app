/**
 * Feed list, checked in rather than stored in a table so that changing it goes
 * through review and a deploy (ADR 0003).
 *
 * M1 deliberately runs on a single feed to prove the fetch → store → serve
 * pipeline. The real curated list of 10+ tech/programming sources is M2
 * (task 8 in `docs/plans/news-aggregator.md`).
 *
 * Hacker News' front-page RSS is the M1 choice: the URL has been stable for well
 * over a decade, it needs no key or quota, it is plain RSS 2.0 with
 * `title`/`link`/`pubDate`, and each item links straight to the original article
 * rather than to an interstitial.
 */
export const FEED_URLS: readonly string[] = ['https://news.ycombinator.com/rss'];
