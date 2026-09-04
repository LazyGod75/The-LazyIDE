/* brainNoteLoad — wiki payload for the selected neuron.
   Extracted from BrainSpace so the nested loadNoteWeb/loadNote callbacks
   (complexity 26) leave the space; each helper stays under the eslint
   complexity ratchet. */

import { buildWikiPayloadFromMeta } from './brainAdapter';
import { parseNoteIdentity } from './queryCssParse';
import { getBrainConnection } from '../platform/tauri';
import type { BrainNoteMeta } from '../platform/types';
import type { WikiLink, WikiPayload } from '../mock/brain';

type TFunc = (key: string, params?: Record<string, string | number>) => string;

export interface WikiGraphLink {
  source: string;
  target: string;
  type: string;
}

export interface WikiNoteName {
  id: string;
  name: string;
}

interface RawNoteMeta {
  id: string;
  title: string;
  type: string;
  topic: string | null;
  tags: string;
  importance: number;
  created: string | null;
  saliencyKind?: string | null;
  conflictWith?: string[];
}

export interface LoadWikiNoteOpts {
  nodeId: string;
  isTauri: boolean;
  t: TFunc;
  links: readonly WikiGraphLink[];
  nodes: readonly WikiNoteName[];
  note: (id: string) => Promise<BrainNoteMeta>;
  noteHtml: (id: string) => Promise<string>;
  fetchWebMeta?: (id: string) => Promise<Response>;
  fetchWebHtml?: (id: string) => Promise<Response>;
  getConnection?: () => Promise<{ port: number; token: string }>;
  fetchSidecarMeta?: (id: string, port: number, token: string) => Promise<Response>;
}

export function wikiEdgeLinks(
  nodeId: string,
  links: readonly WikiGraphLink[],
  names: ReadonlyMap<string, string>,
): WikiLink[] {
  const edgeLinks: WikiLink[] = [];
  for (const link of links) {
    if (link.source === nodeId) {
      const target = names.get(link.target);
      if (target) edgeLinks.push({ label: `${link.type} →`, target });
    } else if (link.target === nodeId) {
      const source = names.get(link.source);
      if (source) edgeLinks.push({ label: `← ${link.type}`, target: source });
    }
  }
  return edgeLinks.slice(0, 12);
}

export function extractWikiBodyFromHtml(noteHtml: string, fallback: string): string {
  const tldrMatch = noteHtml.match(/data-section="tldr"[^>]*>([\s\S]*?)<\/section>/);
  const summaryMatch = noteHtml.match(/data-section="summary"[^>]*>([\s\S]*?)<\/section>/);
  const rawHtml = tldrMatch?.[1] ?? summaryMatch?.[1] ?? '';
  if (!rawHtml) return fallback;
  const bodyText = rawHtml
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return bodyText ? `${bodyText}…` : fallback;
}

function metaFromRaw(raw: RawNoteMeta): BrainNoteMeta {
  return {
    id: raw.id,
    title: raw.title,
    type: raw.type,
    topic: raw.topic,
    tags: raw.tags ?? '',
    importance: raw.importance ?? 0.5,
    created: raw.created,
    saliencyKind: raw.saliencyKind ?? null,
    conflictWith: raw.conflictWith ?? [],
  };
}

function applyHtmlIdentity(payload: WikiPayload, html: string): WikiPayload {
  const identity = parseNoteIdentity(html);
  if (identity.author) payload.author = identity.author;
  if (identity.when) payload.when = identity.when;
  return payload;
}

async function parseNoteMetaResponse(res: Response): Promise<RawNoteMeta> {
  if (!res.ok) throw new Error(`note-meta ${res.status}`);
  return await res.json() as RawNoteMeta;
}

async function loadWikiNoteWeb(opts: LoadWikiNoteOpts): Promise<WikiPayload | null> {
  const fetchMeta = opts.fetchWebMeta ?? ((id) => fetch(`/_api/note-meta/${encodeURIComponent(id)}`));
  const fetchHtml = opts.fetchWebHtml ?? ((id) => fetch(`/_api/note/${encodeURIComponent(id)}`));
  try {
    const raw = await parseNoteMetaResponse(await fetchMeta(opts.nodeId));
    const names = new Map(opts.nodes.map((n) => [n.id, n.name]));
    const fallback = opts.t('brain.neuronFallback', { type: raw.type, cluster: raw.topic ?? 'brain' });
    let bodyText = fallback;
    let noteHtml = '';
    try {
      const noteRes = await fetchHtml(opts.nodeId);
      if (noteRes.ok) {
        noteHtml = await noteRes.text();
        bodyText = extractWikiBodyFromHtml(noteHtml, fallback);
      }
    } catch {
      // use fallback body
    }
    const payload = buildWikiPayloadFromMeta(metaFromRaw(raw), opts.t);
    payload.links = wikiEdgeLinks(opts.nodeId, opts.links, names);
    payload.body = bodyText;
    if (noteHtml) applyHtmlIdentity(payload, noteHtml);
    return payload;
  } catch {
    return null;
  }
}

async function loadWikiNoteTauriHttp(opts: LoadWikiNoteOpts): Promise<WikiPayload | null> {
  const getConnection = opts.getConnection ?? getBrainConnection;
  const fetchMeta = opts.fetchSidecarMeta ?? ((id, port, token) =>
    fetch(`http://127.0.0.1:${port}/_api/note-meta/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }));
  try {
    const { port, token } = await getConnection();
    const raw = await parseNoteMetaResponse(await fetchMeta(opts.nodeId, port, token));
    return buildWikiPayloadFromMeta(metaFromRaw(raw), opts.t);
  } catch {
    return null;
  }
}

async function loadWikiNoteTauri(opts: LoadWikiNoteOpts): Promise<WikiPayload | null> {
  try {
    const [meta, html] = await Promise.all([
      opts.note(opts.nodeId),
      opts.noteHtml(opts.nodeId).catch(() => ''),
    ]);
    const payload = buildWikiPayloadFromMeta(meta, opts.t);
    if (html) applyHtmlIdentity(payload, html);
    return payload;
  } catch {
    // fall through to HTTP
  }
  return loadWikiNoteTauriHttp(opts);
}

export async function loadWikiNote(opts: LoadWikiNoteOpts): Promise<WikiPayload | null> {
  if (!opts.isTauri) return loadWikiNoteWeb(opts);
  return loadWikiNoteTauri(opts);
}
