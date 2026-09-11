import type { ServerResponse } from 'node:http';
import { readAllNotes } from '../../store/reader.js';
import { getLogger } from '../../util/logger.js';
import { sendError } from '../security.js';

// ---------------------------------------------------------------------------
// GET /_api/synthesis/index — returns brain-index HTML
// ---------------------------------------------------------------------------

export function handleSynthesisIndex(_req: unknown, res: ServerResponse): void {
  const log = getLogger();
  try {
    const allNotes = readAllNotes();
    const brainIndex = allNotes.find((n) => /data-cerveau-type="brain-index"/.test(n.html));
    if (!brainIndex) {
      sendError(res, 404, 'No brain index found. Run: lazybrain dream --synthesize');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(brainIndex.html);
  } catch (err) {
    log.error({ err }, 'API error in /_api/synthesis/index');
    sendError(res, 500, 'Failed to load brain index');
  }
}

// ---------------------------------------------------------------------------
// GET /_api/synthesis/:topic — returns topic-overview HTML
// ---------------------------------------------------------------------------

/** Exact match: this note's own data-cerveau-topic equals the requested
 *  path verbatim (e.g. "cerveau/auth") — how deep Wiki-tree nodes resolve,
 *  since synthesize.ts's Phase 1.5 writes one topic-overview per sub-topic
 *  path, not just per top-level project. */
function matchesExactTopic(html: string, topic: string): boolean {
  const topicMatch = html.match(/data-cerveau-topic="([^"]*)"/);
  return topicMatch != null && topicMatch[1].trim() === topic;
}

/** Top-level match: first segment of data-cerveau-topic, or first tag —
 *  how the brain-index's own project links (single-segment slugs, e.g.
 *  "cerveau") have always resolved; kept as a fallback so those links keep
 *  working unchanged. */
function matchesTopLevelTopic(html: string, topic: string): boolean {
  const topicMatch = html.match(/data-cerveau-topic="([^"]*)"/);
  if (topicMatch != null && topicMatch[1].split('/')[0]?.trim() === topic) return true;
  const tagMatch = html.match(/data-cerveau-tags="([^"]*)"/);
  return tagMatch != null && tagMatch[1].split(',')[0]?.trim() === topic;
}

export function handleSynthesisTopic(_req: unknown, res: ServerResponse, topic: string): void {
  const log = getLogger();
  try {
    const overviews = readAllNotes().filter((n) =>
      /data-cerveau-type="topic-overview"/.test(n.html),
    );
    // Exact path first so a specific sub-topic page (e.g. "cerveau/auth")
    // always wins over an unrelated same-prefix page; first-segment/tag
    // match is the fallback that keeps existing top-level slugs resolving.
    const overview =
      overviews.find((n) => matchesExactTopic(n.html, topic)) ??
      overviews.find((n) => matchesTopLevelTopic(n.html, topic));

    if (!overview) {
      sendError(res, 404, `No synthesis found for topic: ${topic}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(overview.html);
  } catch (err) {
    log.error({ err }, 'API error in /_api/synthesis/:topic');
    sendError(res, 500, 'Failed to load topic overview');
  }
}
