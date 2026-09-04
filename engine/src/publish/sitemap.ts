/**
 * Generates sitemap.xml and robots.txt for the static site.
 *
 * The sitemap lists all published notes so search engines can discover them
 * via the SPA's hash-based routes (#/<id>).
 */
import type { ManifestEntry } from './types.js';

/**
 * Build a sitemap.xml body.
 * Uses lastmod = today's date since we have no per-URL change tracking.
 */
export function buildSitemap(baseUrl: string, entries: ReadonlyArray<ManifestEntry>): string {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const sanitized = baseUrl.replace(/\/$/, '');

  const urls = [
    // Root index
    `  <url>
    <loc>${sanitized}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>`,
    // One URL per note — using fragment routing so crawlers can discover them
    ...entries.map(
      (e) => `  <url>
    <loc>${sanitized}/#/${encodeURIComponent(e.id)}</loc>
    <lastmod>${e.created ? e.created.slice(0, 10) : today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>`,
    ),
  ];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * Build a robots.txt that allows all crawlers and points to the sitemap.
 */
export function buildRobotsTxt(baseUrl: string): string {
  const sanitized = baseUrl.replace(/\/$/, '');
  return ['User-agent: *', 'Allow: /', '', `Sitemap: ${sanitized}/sitemap.xml`, ''].join('\n');
}
