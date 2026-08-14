import { describe, expect, it } from 'vitest';
import type { Article } from '../domain/article.js';
import { escapeHtml, formatPublished, renderArticleListPage } from './render.js';

const article: Article = {
  id: 'a1',
  title: 'A perfectly ordinary title',
  url: 'https://example.com/posts/one?a=1&b=2',
  source: 'example.com',
  publishedAt: '2026-08-13T09:05:00.000Z',
};

describe('escapeHtml', () => {
  it('escapes every character that can break out of markup or an attribute', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('neutralises an injected image tag', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Rust 1.99 released')).toBe('Rust 1.99 released');
  });
});

describe('renderArticleListPage', () => {
  it('renders a full HTML document with one inline stylesheet and no script', () => {
    const html = renderArticleListPage([article]);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('renders a semantic list with a machine-readable published time', () => {
    const html = renderArticleListPage([article]);

    expect(html).toContain('<ol>');
    expect(html).toContain('<li>');
    expect(html).toContain('<time datetime="2026-08-13T09:05:00.000Z">13 Aug 2026, 09:05 UTC</time>');
    expect(html).toContain('example.com');
  });

  it('marks outbound links as untrusted and opens them in a new tab', () => {
    const html = renderArticleListPage([article]);

    expect(html).toContain(
      '<a href="https://example.com/posts/one?a=1&amp;b=2" rel="noopener noreferrer nofollow ugc" target="_blank">',
    );
  });

  it('renders every article in the order it was given', () => {
    const second: Article = { ...article, id: 'a2', title: 'Second', url: 'https://example.com/2' };
    const html = renderArticleListPage([article, second]);

    expect(html.indexOf(article.title)).toBeLessThan(html.indexOf('Second'));
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('renders an empty state rather than an empty list', () => {
    const html = renderArticleListPage([]);

    expect(html).not.toContain('<ol>');
    expect(html).toContain('No articles yet');
  });

  it('escapes a malicious title so no raw < survives in the body', () => {
    const malicious: Article = {
      ...article,
      title: '<img src=x onerror=alert(1)>',
      source: '<script>alert(2)</script>',
    };

    const html = renderArticleListPage([malicious]);
    const body = html.slice(html.indexOf('<body>') + '<body>'.length, html.indexOf('</body>'));
    const withoutTags = body.replace(
      /<\/?(?:main|h1|ol|li|a|p|time|footer)\b[^>]*>/g,
      '',
    );

    expect(withoutTags).not.toContain('<');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)</script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes an attribute break-out smuggled through the url field', () => {
    // normalizeUrl rejects these upstream; the renderer must not rely on that.
    const hostile: Article = { ...article, url: 'https://example.com/"><script>alert(1)</script>' };

    expect(renderArticleListPage([hostile])).not.toContain('<script>');
  });

  it('drops the href entirely for a non-http(s) url and keeps the title readable', () => {
    const hostile: Article = { ...article, url: 'javascript:alert(1)' };

    const html = renderArticleListPage([hostile]);

    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain(article.title);
  });

  it('drops the href for an unparseable url', () => {
    const html = renderArticleListPage([{ ...article, url: 'not a url' }]);

    expect(html).not.toContain('<a ');
    expect(html).toContain(article.title);
  });
});

describe('formatPublished', () => {
  it('formats in UTC', () => {
    expect(formatPublished('2026-01-02T03:04:05.000Z')).toBe('02 Jan 2026, 03:04 UTC');
  });

  it('falls back to the raw value when the timestamp is unusable', () => {
    expect(formatPublished('whenever')).toBe('whenever');
  });
});
