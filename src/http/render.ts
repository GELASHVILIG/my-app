import type { Article } from '../domain/article.js';

/**
 * Rendering per ADR 0004: plain string templates, one inline stylesheet, and no
 * client-side JavaScript at all. This module imports only domain types.
 */

const SITE_TITLE = 'Tech news';

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * The single escaping choke point (ADR 0004). Every piece of feed-derived text —
 * titles, source names, URLs — goes through this before it reaches the page.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Fixed UTC display format. Deliberately not locale-aware: the machine-readable
 * value lives in the `datetime` attribute, and a Lambda's locale is not the
 * reader's anyway.
 */
export function formatPublished(publishedAt: string): string {
  const date = new Date(publishedAt);
  if (Number.isNaN(date.getTime())) return publishedAt;
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return `${pad2(date.getUTCDate())} ${month} ${String(date.getUTCFullYear())}, ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

const STYLE = `:root{color-scheme:light dark}
body{margin:0 auto;padding:2rem 1rem;max-width:44rem;font:16px/1.5 system-ui,sans-serif}
h1{font-size:1.4rem;margin:0 0 1.5rem}
ol{list-style:none;margin:0;padding:0}
li{padding:.75rem 0;border-top:1px solid rgba(128,128,128,.3)}
a{color:inherit;text-decoration:none}
a:hover,a:focus{text-decoration:underline}
.meta{margin:.25rem 0 0;font-size:.85rem;opacity:.7}
footer{margin-top:2rem;font-size:.85rem;opacity:.7}`;

function layout(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(SITE_TITLE)}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/**
 * HTML-escaping does not neutralise a `javascript:` href, so the scheme is
 * checked here too. `normalizeUrl` already rejects non-http(s) at ingest — this
 * is the second layer, so the renderer is safe on its own terms.
 */
function isLinkableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function renderArticle(article: Article): string {
  const title = escapeHtml(article.title);
  return [
    '<li>',
    isLinkableUrl(article.url)
      ? `<a href="${escapeHtml(article.url)}" rel="noopener noreferrer nofollow ugc" target="_blank">${title}</a>`
      : title,
    '<p class="meta">',
    escapeHtml(article.source),
    ' &middot; ',
    `<time datetime="${escapeHtml(article.publishedAt)}">${escapeHtml(formatPublished(article.publishedAt))}</time>`,
    '</p>',
    '</li>',
  ].join('');
}

/** The article list page. Pure: same articles in, same bytes out. */
export function renderArticleListPage(articles: readonly Article[]): string {
  const list =
    articles.length === 0
      ? '<p>No articles yet — the next fetch cycle will fill this in.</p>'
      : `<ol>${articles.map((article) => renderArticle(article)).join('')}</ol>`;

  return layout(
    `<main>
<h1>${escapeHtml(SITE_TITLE)}</h1>
${list}
</main>
<footer>Links go to the original publishers.</footer>`,
  );
}

/** Minimal page for non-200 responses; never contains internal error detail. */
export function renderMessagePage(heading: string, message: string): string {
  return layout(`<main>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
</main>`);
}
