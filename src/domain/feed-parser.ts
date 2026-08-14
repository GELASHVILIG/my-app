import { XMLParser } from 'fast-xml-parser';
import type { Article } from './article.js';
import { articleId, normalizeUrl } from './url.js';

/**
 * Parsing feed XML is pure string-in / data-out, so it lives in the domain even
 * though it uses a library. `fast-xml-parser` never touches I/O.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  // Keep every text node a string: a numeric-looking title is still a title.
  parseTagValue: false,
  parseAttributeValue: false,
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Feeds render a repeated element as an array and a single one as a bare value. */
function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Text of an element, whether it came through as a bare value or `{ '#text': ... }`. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const record = asRecord(value);
  return record === undefined ? undefined : textOf(record['#text']);
}

function toIsoUtc(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** RSS 2.0 `<link>`, falling back to a `<guid>` that happens to be a URL. */
function rssLink(item: Record<string, unknown>): string | undefined {
  const link = textOf(item['link']);
  if (link !== undefined) return link;
  const guid = textOf(item['guid']);
  return guid !== undefined && /^https?:\/\//i.test(guid) ? guid : undefined;
}

/** Atom `<link>`: prefer `rel="alternate"` (or no rel), never `rel="self"`. */
function atomLink(entry: Record<string, unknown>): string | undefined {
  const candidates = asArray(entry['link'])
    .map((link) => asRecord(link))
    .filter((link): link is Record<string, unknown> => link !== undefined)
    .filter((link) => {
      const rel = textOf(link['@_rel']);
      return rel === undefined || rel === 'alternate';
    });
  for (const candidate of candidates) {
    const href = textOf(candidate['@_href']);
    if (href !== undefined) return href;
  }
  return textOf(entry['link']);
}

function toArticle(
  title: string | undefined,
  link: string | undefined,
  published: string | undefined,
  source: string,
): Article | undefined {
  // An item missing any of these cannot be rendered or ordered, so it is dropped
  // rather than backfilled with invented data.
  if (title === undefined || link === undefined || published === undefined) return undefined;
  try {
    const url = normalizeUrl(link);
    return { id: articleId(url), title, url, source, publishedAt: published };
  } catch {
    // InvalidUrlError: one unusable link must not cost us the rest of the feed.
    return undefined;
  }
}

function parseRssItems(channel: Record<string, unknown>, source: string): Article[] {
  return asArray(channel['item'])
    .map((raw) => asRecord(raw))
    .map((item) =>
      item === undefined
        ? undefined
        : toArticle(
            textOf(item['title']),
            rssLink(item),
            toIsoUtc(textOf(item['pubDate']) ?? textOf(item['dc:date'])),
            source,
          ),
    )
    .filter((article): article is Article => article !== undefined);
}

function parseAtomEntries(feed: Record<string, unknown>, source: string): Article[] {
  return asArray(feed['entry'])
    .map((raw) => asRecord(raw))
    .map((entry) =>
      entry === undefined
        ? undefined
        : toArticle(
            textOf(entry['title']),
            atomLink(entry),
            toIsoUtc(textOf(entry['published']) ?? textOf(entry['updated'])),
            source,
          ),
    )
    .filter((article): article is Article => article !== undefined);
}

/**
 * Parse RSS 2.0 or Atom XML into articles, newest-first ordering left to the caller.
 *
 * Never throws: malformed XML, an unknown root element, or individual broken
 * items yield fewer articles (possibly none), because one bad feed must not
 * abort an ingest run (ADR 0003).
 */
export function parseFeed(xml: string, source: string): Article[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch {
    return [];
  }

  const root = asRecord(parsed);
  if (root === undefined) return [];

  const rss = asRecord(root['rss']);
  if (rss !== undefined) {
    const channel = asRecord(rss['channel']) ?? asRecord(asArray(rss['channel'])[0]);
    return channel === undefined ? [] : parseRssItems(channel, source);
  }

  const feed = asRecord(root['feed']);
  if (feed !== undefined) return parseAtomEntries(feed, source);

  return [];
}
