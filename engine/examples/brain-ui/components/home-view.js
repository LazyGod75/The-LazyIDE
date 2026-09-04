// examples/brain-ui/components/home-view.js
// Narrative, pedagogical homepage that explains LazyBrain as agentic memory.
// Data-driven from api-client; degrades gracefully if fields are missing.

import { escapeHtml, formatDate } from './shared.js';
import { mountHomeGraph } from './home-graph.js';

// --- Public entry point ---------------------------------------------------

/**
 * Render the narrative home page into container.
 * @param {Element} container
 * @param {{ notes: Array, tree: object }} data
 */
export async function renderHome(container, { notes, tree }) {
  container.innerHTML = '<div class="loading">Loading brain&hellip;</div>';

  // Derive stats from the already-loaded notes + tree
  const allNotes = getAllNotes(tree);
  const stats = buildStats(allNotes);

  const isEmpty = allNotes.length === 0;

  const sections = isEmpty
    ? buildEmptyState()
    : [
        buildHero(stats),
        buildStatsBar(stats),
        buildHowItWorks(),
        buildRecentActivity(allNotes),
        buildBrowseTopics(allNotes),
        buildEntryPoints(),
      ].join('');

  container.innerHTML = `<div class="home-narrative">${sections}</div>`;

  // Wire all internal navigation
  wireHomeLinks(container);

  // Mount the knowledge graph panel at the top (above hero) when brain has content
  if (!isEmpty) {
    const narrative = container.querySelector('.home-narrative');
    if (narrative && typeof window.vis !== 'undefined') {
      mountHomeGraph(narrative);
    }
  }

  // Launch tour prompt if brain has content and tour has not been dismissed
  if (!isEmpty) {
    injectTourButton(container);
  }
}

// --- Stats derivation -------------------------------------------------------

/**
 * Compute displayable stats from the flat note array.
 * Every field has a safe default — callers must not assume presence.
 * @param {Array} allNotes
 * @returns {{ total: number, projects: number, decisions: number, recentCount: number, recentDate: string }}
 */
function buildStats(allNotes) {
  const projectSet = new Set();
  let decisions = 0;

  for (const note of allNotes) {
    const project = (note.topic || '').split('/')[0];
    if (project && !project.startsWith('_')) projectSet.add(project);
    if (note.type === 'decision') decisions++;
  }

  const recentNotes = [...allNotes]
    .filter(n => n.created)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  const recentDate = recentNotes[0]?.created ?? '';

  return {
    total: allNotes.length,
    projects: projectSet.size,
    decisions,
    recentCount: recentNotes.length,
    recentDate,
  };
}

// --- Hero section -----------------------------------------------------------

function buildHero(stats) {
  const subtitle = stats.total > 0
    ? `${stats.total} notes &middot; ${stats.projects} project${stats.projects !== 1 ? 's' : ''} &middot; ${stats.decisions} decision${stats.decisions !== 1 ? 's' : ''}`
    : 'Your brain is empty — start capturing below.';

  return `<section class="home-hero">
    <h1 class="home-hero-title">LazyBrain</h1>
    <p class="home-hero-tagline">
      An HTML-native, queryable second brain for coding agents.
    </p>
    <p class="home-hero-sub">${subtitle}</p>
  </section>`;
}

// --- Stats bar --------------------------------------------------------------

function buildStatsBar(stats) {
  const lastSeen = stats.recentDate
    ? `Last capture: <strong>${escapeHtml(formatDate(stats.recentDate))}</strong>`
    : '';

  return `<div class="home-stats-bar" role="region" aria-label="Brain statistics">
    <div class="home-stat">
      <span class="home-stat-value">${stats.total}</span>
      <span class="home-stat-label">notes</span>
    </div>
    <div class="home-stat">
      <span class="home-stat-value">${stats.projects}</span>
      <span class="home-stat-label">project${stats.projects !== 1 ? 's' : ''}</span>
    </div>
    <div class="home-stat">
      <span class="home-stat-value">${stats.decisions}</span>
      <span class="home-stat-label">decision${stats.decisions !== 1 ? 's' : ''}</span>
    </div>
    ${lastSeen ? `<div class="home-stat home-stat--text">${lastSeen}</div>` : ''}
  </div>`;
}

// --- How it works (3-step) --------------------------------------------------

function buildHowItWorks() {
  const steps = [
    {
      num: '1',
      title: 'Capture',
      body: 'Agents write HTML notes directly into the brain — decisions, code modules, concepts, references — each typed and timestamped.',
    },
    {
      num: '2',
      title: 'Structure',
      body: 'Notes are indexed into a topic tree and knowledge graph. Related notes link to each other; the brain grows without manual curation.',
    },
    {
      num: '3',
      title: 'Recall',
      body: 'Search full-text or browse by topic. Agents query the brain before each task so settled decisions are never re-litigated.',
    },
  ];

  const cards = steps.map(step => `
    <article class="how-card">
      <div class="how-card-num" aria-hidden="true">${escapeHtml(step.num)}</div>
      <h3 class="how-card-title">${escapeHtml(step.title)}</h3>
      <p class="how-card-body">${escapeHtml(step.body)}</p>
    </article>
  `).join('');

  return `<section class="home-how" aria-labelledby="how-heading">
    <h2 class="home-section-title" id="how-heading">How it works</h2>
    <div class="how-grid">${cards}</div>
  </section>`;
}

// --- Recent activity --------------------------------------------------------

function buildRecentActivity(allNotes) {
  const recent = [...allNotes]
    .filter(n => n.created)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''))
    .slice(0, 8);

  if (recent.length === 0) return '';

  const items = recent.map(note => {
    const cls = (note.type || '').toLowerCase();
    const typeLabel = (note.type || '?').slice(0, 3).toUpperCase();
    const topic = note.topic
      ? `<span class="activity-topic">${escapeHtml(note.topic)}</span>`
      : '';
    return `<li class="activity-item"
              data-note-href="#/wiki/${escapeHtml(note.id)}"
              role="button"
              tabindex="0"
              aria-label="Open note: ${escapeHtml(note.title || note.id)}">
      <span class="activity-date">${escapeHtml(formatDate(note.created))}</span>
      <span class="type-badge ${cls}">${escapeHtml(typeLabel)}</span>
      <span class="activity-title">${escapeHtml(note.title || note.id)}</span>
      ${topic}
    </li>`;
  }).join('');

  return `<section class="home-section" aria-labelledby="recent-heading">
    <h2 class="home-section-title" id="recent-heading">Recent captures</h2>
    <ul class="activity-list" data-note-list>${items}</ul>
  </section>`;
}

// --- Entry points -----------------------------------------------------------

function buildEntryPoints() {
  const links = [
    { href: '#/browse', label: 'Browse all notes A–Z' },
    { href: '#/search/', label: 'Search the brain' },
    { href: '#/stats', label: 'Stats & health' },
    { href: '#/timeline', label: 'Timeline' },
  ];

  // Thesis link: relative URL that works on the deployed Pages site where
  // why-html.html is served at the same root as the demo.
  // Acceptable that it 404s when only demo/ is served locally without the thesis.
  const thesisHtml = `<a class="entry-btn entry-btn--thesis"
      href="./why-html.html"
      title="Why HTML beats Markdown for an LLM&apos;s memory &mdash; data-backed thesis">
    Read the thesis: Why HTML beats Markdown for AI memory
  </a>`;

  const btns = links.map(({ href, label }) =>
    `<a class="entry-btn"
        href="${escapeHtml(href)}"
        data-spa-href="${escapeHtml(href)}">
      ${escapeHtml(label)}
    </a>`
  ).join('');

  return `<nav class="home-entry-points" aria-label="Quick entry points">
    ${btns}
    ${thesisHtml}
  </nav>`;
}

// --- Browse topics section --------------------------------------------------

/**
 * Build a "Browse topics" section listing top-level topics with note counts.
 * Capped at 30 topics, sorted by note count descending.
 * Uses data already available (allNotes) — no additional fetch.
 * @param {Array} allNotes
 * @returns {string}
 */
function buildBrowseTopics(allNotes) {
  if (allNotes.length === 0) return '';

  // Aggregate counts per top-level topic (first path segment).
  const topicCounts = new Map();
  for (const note of allNotes) {
    const rawTopic = (note.topic || '').trim();
    if (!rawTopic || rawTopic.startsWith('_')) continue;
    const top = rawTopic.split('/')[0];
    topicCounts.set(top, (topicCounts.get(top) || 0) + 1);
  }

  if (topicCounts.size === 0) return '';

  const sorted = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  const items = sorted.map(([topic, count]) => {
    const href = `#/${escapeHtml(topic)}`;
    return `<li>
      <a class="topic-entry-link"
         href="${href}"
         data-spa-href="${href}"
         aria-label="${escapeHtml(topic)}: ${count} note${count !== 1 ? 's' : ''}">
        ${escapeHtml(topic)}
        <span class="topic-entry-count">${count}</span>
      </a>
    </li>`;
  }).join('');

  return `<section class="home-section home-topics-section" aria-labelledby="topics-heading">
    <h2 class="home-section-title" id="topics-heading">Browse topics</h2>
    <ul class="home-topics-list" data-topics-list>
      ${items}
    </ul>
  </section>`;
}

// --- Empty state (pedagogical) ----------------------------------------------

function buildEmptyState() {
  return `<section class="home-empty">
    <div class="home-hero">
      <h1 class="home-hero-title">LazyBrain</h1>
      <p class="home-hero-tagline">
        An HTML-native, queryable second brain for coding agents.
      </p>
    </div>

    <div class="home-empty-body">
      <h2>Your brain is empty</h2>
      <p>
        LazyBrain stores structured memory for AI coding agents.
        Each note is an HTML file — typed, dated, and indexed — so agents can
        recall past decisions, explore your codebase structure, and avoid
        re-litigating choices already made.
      </p>

      <h3>How to capture your first memory</h3>
      <ol class="empty-steps">
        <li>Run <code>lazybrain capture</code> in your project root to extract notes from past conversations.</li>
        <li>Or run <code>lazybrain graph</code> to scan your codebase and build a code-first knowledge graph.</li>
        <li>Once notes exist, reload this page — the brain will come alive.</li>
      </ol>

      <p class="empty-hint">
        Not sure where to start?
        <a href="https://github.com/your-org/lazybrain" target="_blank" rel="noopener">
          Read the docs
        </a>
        or run <code>lazybrain --help</code>.
      </p>
    </div>
  </section>`;
}

// --- Tour button injection --------------------------------------------------

/**
 * Check whether the user has permanently dismissed the tour.
 * Inline check (mirrors tour.js isTourDismissed) — avoids a dynamic import
 * just to decide whether to show the button.
 * @returns {boolean}
 */
function isTourAlreadyDismissed() {
  try {
    return localStorage.getItem('lazybrain-tour-dismissed') === '1';
  } catch {
    return false;
  }
}

/**
 * Inject the "Guided tour" button near the hero if it has not been dismissed.
 * The tour component is loaded lazily to avoid circular imports.
 * @param {Element} container
 */
function injectTourButton(container) {
  if (isTourAlreadyDismissed()) return;

  const hero = container.querySelector('.home-hero');
  if (!hero) return;

  const btn = document.createElement('button');
  btn.className = 'tour-launch-btn';
  btn.type = 'button';
  btn.textContent = 'Take the guided tour';
  btn.setAttribute('aria-label', 'Start the guided tour of LazyBrain');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { startTour } = await import('./tour.js');
      startTour();
      btn.remove();
    } catch {
      // If the tour module fails to load for any reason, re-enable the button
      // so the user can try again rather than seeing a dead button.
      btn.disabled = false;
    }
  });

  hero.appendChild(btn);
}

// --- Event wiring -----------------------------------------------------------

/**
 * Wire all SPA navigation links and note-list click handlers.
 * Uses event delegation — no inline handlers.
 * @param {Element} container
 */
function wireHomeLinks(container) {
  // [data-spa-href] links: entry points, etc.
  for (const a of container.querySelectorAll('a[data-spa-href]')) {
    if (a.dataset.clickBound) continue;
    a.dataset.clickBound = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.dataset.spaHref;
    });
  }

  // Delegate note list clicks and keyboard activation
  for (const list of container.querySelectorAll('[data-note-list]')) {
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-note-href]');
      if (!item) return;
      location.hash = item.dataset.noteHref;
    });

    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('[data-note-href]');
      if (!item) return;
      e.preventDefault();
      location.hash = item.dataset.noteHref;
    });
  }
}

// --- Shared tree helpers (exported for topic-view) --------------------------

export function getAllNotes(tree) {
  const result = [...tree.notes];
  for (const child of tree.children.values()) {
    result.push(...getAllNotesUnder(child));
  }
  return result;
}

function getAllNotesUnder(node) {
  const result = [...node.notes];
  for (const child of node.children.values()) {
    result.push(...getAllNotesUnder(child));
  }
  return result;
}

export function getNotesUnder(tree, pathParts) {
  let node = tree;
  for (const part of pathParts) {
    if (!node.children.has(part)) return [];
    node = node.children.get(part);
  }
  return getAllNotesUnder(node);
}

export function buildSubtopicGrid(pathParts, node, tree) {
  if (node.children.size === 0) return '';

  const sorted = [...node.children.entries()]
    .filter(([name]) => !name.startsWith('_'))
    .sort((a, b) => {
      const aCount = getNotesUnder(tree, [...pathParts, a[0]]).length;
      const bCount = getNotesUnder(tree, [...pathParts, b[0]]).length;
      return bCount - aCount;
    });

  const cards = sorted.map(([name]) => {
    const childNotes = getNotesUnder(tree, [...pathParts, name]);
    const path = [...pathParts, name].join('/');
    const typeDist = buildTypeDistribution(childNotes);

    return `<article class="topic-card">
      <a href="#/${escapeHtml(path)}" data-spa-href="#/${escapeHtml(path)}">
        <header><h2 class="card-title">${escapeHtml(name)}</h2></header>
        <div class="card-count">${childNotes.length} notes</div>
        ${typeDist}
      </a>
    </article>`;
  }).join('');

  return `<h2>Sub-topics</h2><div class="grid">${cards}</div>`;
}

function buildTypeDistribution(childNotes) {
  const dist = {};
  for (const n of childNotes) {
    const t = n.type || 'other';
    dist[t] = (dist[t] || 0) + 1;
  }
  return Object.entries(dist).map(([t, count]) =>
    `<div style="font-size:12px;color:#666;margin-top:4px;"><span class="type-badge ${escapeHtml(t)}">${count} ${escapeHtml(t)}${count !== 1 ? 's' : ''}</span></div>`
  ).join('');
}

export function buildNotesByType(notesToShow, isLeaf, allNotes) {
  const source = isLeaf ? allNotes : notesToShow;
  if (source.length === 0) return '';

  const byType = { decision: [], reference: [], episodic: [], concept: [], other: [] };
  for (const n of source) {
    const bucket = byType[n.type] || byType.other;
    bucket.push(n);
  }

  const typeLabels = {
    decision: 'Decisions',
    reference: 'References',
    episodic: 'History',
    concept: 'Concepts',
    procedural: 'Procedures',
    integration: 'Integrations',
    other: 'Notes',
  };

  return Object.entries(byType)
    .filter(([, typeNotes]) => typeNotes.length > 0)
    .map(([type, typeNotes]) => {
      const label = typeLabels[type] || 'Notes';
      const sorted = [...typeNotes].sort((a, b) => {
        const ia = Number.parseFloat(a.importance || '0');
        const ib = Number.parseFloat(b.importance || '0');
        if (ia !== ib) return ib - ia;
        return (b.created || '').localeCompare(a.created || '');
      });

      const items = sorted.map(note => {
        const cls = (note.type || '').toLowerCase();
        return `<li data-note-href="#/wiki/${escapeHtml(note.id)}" role="button" tabindex="0"
                  aria-label="Open: ${escapeHtml(note.title || note.id)}">
          <span class="type-badge ${escapeHtml(cls)}">${escapeHtml((note.type || '?').slice(0, 3).toUpperCase())}</span>
          ${escapeHtml(note.title || note.id)}
          <span class="note-date">${escapeHtml(formatDate(note.created))}</span>
        </li>`;
      }).join('');

      return `<h2>${escapeHtml(label)} (${typeNotes.length})</h2><ul class="note-list" data-note-list>${items}</ul>`;
    }).join('');
}

/**
 * Wire [data-spa-href] links and [data-note-list] delegated click handlers.
 * Called from topic-view.js after building the HTML.
 * @param {Element} container
 */
export function wireNoteLinks(container) {
  for (const a of container.querySelectorAll('a[data-spa-href]')) {
    if (a.dataset.clickBound) continue;
    a.dataset.clickBound = '1';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      location.hash = a.dataset.spaHref;
    });
  }

  for (const list of container.querySelectorAll('[data-note-list]')) {
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-note-href]');
      if (!item) return;
      location.hash = item.dataset.noteHref;
    });

    list.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target.closest('[data-note-href]');
      if (!item) return;
      e.preventDefault();
      location.hash = item.dataset.noteHref;
    });
  }
}
