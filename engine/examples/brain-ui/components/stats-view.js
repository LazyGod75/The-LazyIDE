// examples/brain-ui/components/stats-view.js
// Brain health dashboard component.

import { escapeHtml } from './shared.js';

/**
 * Render the stats dashboard into container.
 * @param {Element} container
 * @param {{ notes: Array }} data
 */
export function renderStats(container, { notes }) {
  if (!notes || notes.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <h2>Brain Health Dashboard</h2>
      <p>No notes found in the brain yet.</p>
      <p>Run <code>lazybrain build</code> to extract knowledge from your codebase,
         then refresh to see your stats.</p>
    </div>`;
    return;
  }

  const stats = buildStats(notes);

  let html = `<h1>Brain Health Dashboard</h1>`;

  html += renderOverview(stats);
  html += renderByType(stats);
  html += renderByMonth(stats);
  html += renderTopTopics(stats);

  container.innerHTML = html;
  wireTopicLinks(container);
}

function buildStats(notes) {
  const stats = {
    totalNotes: notes.length,
    byType: {},
    byTopic: {},
    decisions: 0,
    byMonth: {}
  };

  for (const note of notes) {
    const t = note.type || 'other';
    stats.byType[t] = (stats.byType[t] || 0) + 1;

    const topic = note.topic || '_uncategorized';
    stats.byTopic[topic] = (stats.byTopic[topic] || 0) + 1;

    if (t === 'decision') stats.decisions++;

    const month = note.created ? note.created.slice(0, 7) : 'unknown';
    stats.byMonth[month] = (stats.byMonth[month] || 0) + 1;
  }

  return stats;
}

function renderOverview(stats) {
  return `<div class="stats-section">
    <h2>Overview</h2>
    <div class="stats-grid">
      <div class="stat-item">
        <div class="stat-value">${stats.totalNotes}</div>
        <div class="stat-label">Total Notes</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${Object.keys(stats.byType).length}</div>
        <div class="stat-label">Note Types</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${stats.decisions}</div>
        <div class="stat-label">Decisions</div>
      </div>
      <div class="stat-item">
        <div class="stat-value">${Object.keys(stats.byTopic).length}</div>
        <div class="stat-label">Topics</div>
      </div>
    </div>
  </div>`;
}

function renderByType(stats) {
  const entries = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    return `<div class="stats-section">
      <h2>Notes by Type</h2>
      <p class="stats-empty">No typed notes yet.</p>
    </div>`;
  }
  const maxCount = Math.max(...entries.map((e) => e[1]));

  const bars = entries.map(([type, count]) => {
    const height = (count / maxCount) * 180;
    return `<div class="bar-item">
      <div class="bar-fill" style="height: ${height}px"></div>
      <div class="bar-value">${count}</div>
      <div class="bar-label">${escapeHtml(type)}</div>
    </div>`;
  }).join('');

  return `<div class="stats-section">
    <h2>Notes by Type</h2>
    <div class="bar-chart">${bars}</div>
  </div>`;
}

function renderByMonth(stats) {
  const entries = Object.entries(stats.byMonth).sort().slice(-12);
  if (entries.length === 0) {
    return `<div class="stats-section">
      <h2>Activity Over Time</h2>
      <p class="stats-empty">No dated notes found — add a <code>created</code> field to your notes to see activity.</p>
    </div>`;
  }
  const maxCount = Math.max(...entries.map((e) => e[1]));

  const bars = entries.map(([month, count]) => {
    const height = (count / maxCount) * 180;
    return `<div class="bar-item">
      <div class="bar-fill" style="height: ${height}px"></div>
      <div class="bar-value">${count}</div>
      <div class="bar-label">${escapeHtml(month)}</div>
    </div>`;
  }).join('');

  return `<div class="stats-section">
    <h2>Activity Over Time</h2>
    <div class="bar-chart">${bars}</div>
  </div>`;
}

function renderTopTopics(stats) {
  const top = Object.entries(stats.byTopic).sort((a, b) => b[1] - a[1]).slice(0, 10);

  const items = top.map(([topic, count]) => {
    const display = topic === '_uncategorized' ? '(Uncategorized)' : topic;
    return `<li data-topic-href="#/${escapeHtml(topic)}" style="cursor:pointer">
      <strong>${escapeHtml(display)}</strong>
      <span class="note-date">${count} notes</span>
    </li>`;
  }).join('');

  return `<div class="stats-section">
    <h2>Top Topics</h2>
    <ul class="note-list" data-topic-list>${items}</ul>
  </div>`;
}

/**
 * Wire topic list click navigation via event delegation.
 * @param {Element} container
 */
function wireTopicLinks(container) {
  for (const list of container.querySelectorAll('[data-topic-list]')) {
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-topic-href]');
      if (!item) return;
      location.hash = item.dataset.topicHref;
    });
  }
}
