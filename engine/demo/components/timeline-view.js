// examples/brain-ui/components/timeline-view.js
// Chronological timeline of all notes — incremental rendering for scale.

import { escapeHtml } from './shared.js';

const BATCH_SIZE = 100;

/**
 * Render the timeline view into container with incremental loading.
 * First batch (BATCH_SIZE groups) renders immediately; subsequent batches
 * are appended via IntersectionObserver sentinel or "Load more" button fallback.
 *
 * @param {Element} container
 * @param {{ notes: Array }} data
 */
export function renderTimeline(container, { notes }) {
  if (!notes || notes.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <h2>Timeline View</h2>
      <p>No notes found yet — nothing to display on the timeline.</p>
      <p>Run <code>lazybrain build</code> to populate the brain, then come back here
         to see your knowledge grow over time.</p>
    </div>`;
    return;
  }

  const sorted = [...notes].sort((a, b) => {
    return new Date(b.created || '2000-01-01') - new Date(a.created || '2000-01-01');
  });

  const byDate = groupByDate(sorted);
  const datedEntries = Object.entries(byDate).filter(([d]) => d !== 'unknown');
  const unknownEntries = Object.entries(byDate).filter(([d]) => d === 'unknown');

  if (datedEntries.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <h2>Timeline View</h2>
      <p>Notes exist, but none have a <code>created</code> date field.</p>
      <p>Add <code>created: YYYY-MM-DD</code> metadata to your notes to see them here.</p>
    </div>`;
    return;
  }

  // Build flat ordered list of all date-groups (newest first) + undated at end.
  const allGroups = datedEntries.sort().reverse().map(([date, dateNotes]) => ({ date, notes: dateNotes }));
  if (unknownEntries.length > 0) {
    allGroups.push({ date: 'unknown', notes: unknownEntries[0][1] });
  }

  // Outer wrapper — static header + scrollable container
  container.innerHTML = `<h1>Timeline View</h1>
    <p style="color: #666; margin-bottom: 24px;">Notes organized chronologically</p>
    <div class="timeline-container" data-timeline></div>`;

  const timelineEl = container.querySelector('[data-timeline]');
  // Wire click navigation via event delegation on the container (one listener).
  wireTimelineLinks(container);

  // Track how many items (individual notes) have been rendered so far.
  let renderedItemCount = 0;
  let groupIdx = 0;

  /**
   * Append up to BATCH_SIZE more note items from allGroups.
   * Returns true if there are still more items to render.
   * @returns {boolean}
   */
  function appendBatch() {
    let added = 0;
    while (groupIdx < allGroups.length && added < BATCH_SIZE) {
      const { date, notes: groupNotes } = allGroups[groupIdx];

      // Find or create the date heading wrapper for this group.
      let groupEl = timelineEl.querySelector(`[data-date-group="${CSS.escape(date)}"]`);
      if (!groupEl) {
        groupEl = document.createElement('div');
        groupEl.setAttribute('data-date-group', date);
        groupEl.style.marginBottom = '24px';
        const label = date === 'unknown' ? 'No date' : date;
        const color = date === 'unknown' ? '#bbb' : '#666';
        groupEl.innerHTML = `<h3 style="font-size: 16px; margin-bottom: 12px; color: ${color};">${escapeHtml(label)}</h3>`;
        timelineEl.appendChild(groupEl);
      }

      // How many notes in this group have already been rendered?
      const alreadyRendered = groupEl.querySelectorAll('.timeline-item').length;
      const remaining = groupNotes.slice(alreadyRendered);

      for (const note of remaining) {
        if (added >= BATCH_SIZE) break;
        groupEl.insertAdjacentHTML('beforeend', renderTimelineItem(note, date));
        added++;
        renderedItemCount++;
      }

      // If we rendered all notes in this group, move to next group.
      if (alreadyRendered + added >= groupNotes.length) {
        groupIdx++;
      } else {
        // Partial group — stop here; next batch will continue this group.
        break;
      }
    }

    const hasMore = groupIdx < allGroups.length;
    return hasMore;
  }

  // Render the first batch immediately.
  const hasMore = appendBatch();

  if (!hasMore) return;

  // Attach sentinel for incremental loading.
  const sentinel = document.createElement('div');
  sentinel.id = 'timeline-sentinel';
  sentinel.setAttribute('data-timeline-sentinel', '');
  sentinel.style.cssText = 'height: 1px; margin-top: 8px;';
  timelineEl.appendChild(sentinel);

  // Load-more button — always rendered as fallback for IntersectionObserver.
  const loadMoreBtn = document.createElement('button');
  loadMoreBtn.type = 'button';
  loadMoreBtn.id = 'timeline-load-more';
  loadMoreBtn.textContent = 'Load more';
  loadMoreBtn.style.cssText =
    'display:block;margin:16px auto;padding:8px 24px;cursor:pointer;' +
    'background:var(--accent,#1a73e8);color:#fff;border:none;border-radius:4px;font-size:14px;';
  timelineEl.appendChild(loadMoreBtn);

  function loadMore() {
    const more = appendBatch();
    if (!more) {
      sentinel.remove();
      loadMoreBtn.remove();
      if (observer) observer.disconnect();
    }
  }

  loadMoreBtn.addEventListener('click', loadMore);

  // IntersectionObserver for automatic loading when the sentinel scrolls into view.
  let observer = null;
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: '200px' },
    );
    observer.observe(sentinel);
  }
}

function groupByDate(notes) {
  const byDate = {};
  for (const note of notes) {
    const date = note.created ? note.created.slice(0, 10) : 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(note);
  }
  return byDate;
}

function renderTimelineItem(note, date) {
  const typeClass = (note.type || 'other').toLowerCase();
  const validityBar = buildValidityBar(note);

  return `<div class="timeline-item ${typeClass}">
    <div class="timeline-marker">${escapeHtml(date.slice(5))}</div>
    <div class="timeline-content">
      <div class="timeline-title" data-note-href="#/wiki/${escapeHtml(note.id)}" style="cursor:pointer">
        ${escapeHtml(note.title || note.id)}
      </div>
      <div class="timeline-date">
        <span class="type-badge ${typeClass}">${(note.type || '?').slice(0, 3).toUpperCase()}</span>
        ${note.topic ? `<span style="color: #666; font-size: 12px;">${escapeHtml(note.topic)}</span>` : ''}
      </div>
      ${validityBar}
    </div>
  </div>`;
}

function buildValidityBar(note) {
  const validFrom = note.validFrom ? new Date(note.validFrom) : null;
  const validUntil = note.validUntil ? new Date(note.validUntil) : null;

  if (!validFrom || !validUntil) return '';

  const now = new Date();
  const total = validUntil.getTime() - validFrom.getTime();
  const elapsed = now.getTime() - validFrom.getTime();
  const percentage = Math.max(0, Math.min(100, (elapsed / total) * 100));

  return `<div class="timeline-bar">
    <div class="timeline-validity" style="width: ${percentage}%"></div>
  </div>`;
}

/**
 * Wire timeline item click navigation via event delegation.
 * @param {Element} container
 */
function wireTimelineLinks(container) {
  const timeline = container.querySelector('[data-timeline]');
  if (!timeline) return;
  timeline.addEventListener('click', (e) => {
    const item = e.target.closest('[data-note-href]');
    if (!item) return;
    location.hash = item.dataset.noteHref;
  });
}
