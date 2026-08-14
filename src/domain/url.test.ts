import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidUrlError, articleId, normalizeUrl } from './url.js';

describe('normalizeUrl', () => {
  it('lowercases the scheme and the host but preserves path case', () => {
    expect(normalizeUrl('HTTPS://Example.COM/Path/To/Article')).toBe(
      'https://example.com/Path/To/Article',
    );
  });

  it('drops the default port for http and https', () => {
    expect(normalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(normalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });

  it('keeps a non-default port', () => {
    expect(normalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('drops the fragment', () => {
    expect(normalizeUrl('https://example.com/a#section-2')).toBe('https://example.com/a');
  });

  it('drops utm_* parameters', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=hn&utm_campaign=x&id=7')).toBe(
      'https://example.com/a?id=7',
    );
  });

  it('drops the named tracking parameters', () => {
    expect(normalizeUrl('https://example.com/a?ref=hn&source=rss&fbclid=1&gclid=2&keep=yes')).toBe(
      'https://example.com/a?keep=yes',
    );
  });

  it('leaves no query string behind when every parameter was tracking', () => {
    expect(normalizeUrl('https://example.com/a?utm_source=hn&ref=x')).toBe('https://example.com/a');
  });

  it('sorts the remaining parameters by key', () => {
    expect(normalizeUrl('https://example.com/a?z=1&b=2&a=3')).toBe(
      'https://example.com/a?a=3&b=2&z=1',
    );
  });

  it('strips exactly one trailing slash', () => {
    expect(normalizeUrl('https://example.com/a/b/')).toBe('https://example.com/a/b');
    expect(normalizeUrl('https://example.com/a/b//')).toBe('https://example.com/a/b/');
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  // Pinned deliberately: query values are re-encoded as
  // application/x-www-form-urlencoded, so a space becomes `+` and `~` becomes
  // `%7E`. Since articleId hashes this string, changing the encoding changes
  // every future article id — it must fail here first (ADR 0002).
  it('re-encodes query values as x-www-form-urlencoded', () => {
    expect(normalizeUrl('https://example.com/a?q=hello%20world~x')).toBe(
      'https://example.com/a?q=hello+world%7Ex',
    );
    expect(normalizeUrl("https://example.com/a?q=a!b(c)d'e")).toBe(
      'https://example.com/a?q=a%21b%28c%29d%27e',
    );
  });

  it('applies every rule together', () => {
    expect(
      normalizeUrl('HTTPS://News.Example.com:443/Posts/Deep-Dive/?utm_medium=rss&z=1&a=2#comments'),
    ).toBe('https://news.example.com/Posts/Deep-Dive?a=2&z=1');
  });

  it('rejects an unparseable url', () => {
    expect(() => normalizeUrl('not a url')).toThrow(InvalidUrlError);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(InvalidUrlError);
    expect(() => normalizeUrl('ftp://example.com/a')).toThrow(InvalidUrlError);
  });

  it('reports a machine-readable code', () => {
    try {
      normalizeUrl('not a url');
      expect.unreachable('normalizeUrl should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidUrlError);
      expect((error as InvalidUrlError).code).toBe('INVALID_URL');
    }
  });
});

describe('articleId', () => {
  it('is the lowercase hex sha-256 of the normalized url', () => {
    const url = 'https://example.com/a';
    expect(articleId(url)).toBe(createHash('sha256').update(url, 'utf8').digest('hex'));
    expect(articleId(url)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for urls differing only in tracking parameters', () => {
    expect(articleId(normalizeUrl('https://example.com/a?utm_source=hn'))).toBe(
      articleId(normalizeUrl('https://example.com/a?ref=twitter')),
    );
  });

  it('is stable for urls differing only in a trailing slash or fragment', () => {
    expect(articleId(normalizeUrl('https://example.com/a/'))).toBe(
      articleId(normalizeUrl('https://example.com/a#top')),
    );
  });

  it('differs for genuinely different urls', () => {
    expect(articleId(normalizeUrl('https://example.com/a'))).not.toBe(
      articleId(normalizeUrl('https://example.com/b')),
    );
  });
});
