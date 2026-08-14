import { describe, expect, it } from 'vitest';
import { parseFeed } from './feed-parser.js';
import { articleId, normalizeUrl } from './url.js';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Tech</title>
    <item>
      <title><![CDATA[A & B: shipping fast]]></title>
      <link>https://example.com/posts/one/?utm_source=rss</link>
      <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
      <guid isPermaLink="false">tag:example.com,2026:1</guid>
    </item>
    <item>
      <title>Second post</title>
      <guid isPermaLink="true">https://example.com/posts/two</guid>
      <pubDate>Wed, 13 Aug 2026 11:30:00 +0000</pubDate>
    </item>
    <item>
      <title>No link at all</title>
      <pubDate>Wed, 13 Aug 2026 12:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Unparseable date</title>
      <link>https://example.com/posts/three</link>
      <pubDate>whenever</pubDate>
    </item>
    <item>
      <title>Dangerous scheme</title>
      <link>javascript:alert(1)</link>
      <pubDate>Wed, 13 Aug 2026 13:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <entry>
    <title type="html">Atom entry</title>
    <link rel="self" href="https://example.com/feed.atom"/>
    <link rel="alternate" href="https://example.com/atom/one"/>
    <published>2026-08-12T09:00:00Z</published>
    <updated>2026-08-12T10:00:00Z</updated>
  </entry>
  <entry>
    <title>Updated only</title>
    <link href="https://example.com/atom/two"/>
    <updated>2026-08-13T08:15:00+02:00</updated>
  </entry>
</feed>`;

describe('parseFeed (RSS 2.0)', () => {
  it('parses items into articles with a normalized url and dedup id', () => {
    const articles = parseFeed(RSS_FIXTURE, 'Example Tech');
    const first = articles[0];

    expect(first).toBeDefined();
    expect(first?.title).toBe('A & B: shipping fast');
    expect(first?.url).toBe('https://example.com/posts/one');
    expect(first?.source).toBe('Example Tech');
    expect(first?.publishedAt).toBe('2026-08-12T09:00:00.000Z');
    expect(first?.id).toBe(articleId(normalizeUrl('https://example.com/posts/one')));
  });

  it('falls back to a guid that is a url', () => {
    const articles = parseFeed(RSS_FIXTURE, 'Example Tech');
    expect(articles.map((a) => a.url)).toContain('https://example.com/posts/two');
  });

  it('skips items without a link, without a usable date, or with a rejected scheme', () => {
    const titles = parseFeed(RSS_FIXTURE, 'Example Tech').map((a) => a.title);
    expect(titles).toEqual(['A & B: shipping fast', 'Second post']);
  });

  it('handles a channel with exactly one item', () => {
    const xml = `<rss version="2.0"><channel><item><title>Only</title><link>https://example.com/only</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
    expect(parseFeed(xml, 'Solo')).toHaveLength(1);
  });
});

describe('parseFeed (Atom)', () => {
  it('parses entries and prefers the alternate link over rel="self"', () => {
    const articles = parseFeed(ATOM_FIXTURE, 'Example Atom');
    expect(articles).toHaveLength(2);
    expect(articles[0]?.title).toBe('Atom entry');
    expect(articles[0]?.url).toBe('https://example.com/atom/one');
    expect(articles[0]?.publishedAt).toBe('2026-08-12T09:00:00.000Z');
  });

  it('falls back to updated when published is absent, normalizing to UTC', () => {
    const articles = parseFeed(ATOM_FIXTURE, 'Example Atom');
    expect(articles[1]?.publishedAt).toBe('2026-08-13T06:15:00.000Z');
  });
});

describe('parseFeed (bad input)', () => {
  it.each([
    ['truncated xml', '<rss><channel><item><title>Broken'],
    ['not xml at all', 'this is not xml'],
    ['empty string', ''],
    ['html error page', '<html><body><h1>503 Service Unavailable</h1></body></html>'],
    ['unknown root element', '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/>'],
  ])('returns an empty list for %s instead of throwing', (_name, xml) => {
    expect(() => parseFeed(xml, 'Broken')).not.toThrow();
    expect(parseFeed(xml, 'Broken')).toEqual([]);
  });

  it('keeps the good items from a feed containing a broken one', () => {
    const xml = `<rss version="2.0"><channel>
      <item><title>Good</title><link>https://example.com/good</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item>
      <item><link>https://example.com/no-title</link><pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate></item>
    </channel></rss>`;
    expect(parseFeed(xml, 'Mixed').map((a) => a.title)).toEqual(['Good']);
  });
});
