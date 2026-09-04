// examples/brain-ui/components/tour.js
// Lightweight, dismissible guided tour for LazyBrain.
// No external dependencies. Dismissal is persisted in localStorage.
// All navigation handled via addEventListener + data-* attributes — no inline handlers.

const STORAGE_KEY = 'lazybrain-tour-dismissed';

/** @type {HTMLElement|null} */
let overlay = null;

/** @type {HTMLElement|null} */
let spotlight = null;

/** @type {number} */
let currentStep = 0;

/** @type {number|null} ResizeObserver / scroll repositioning handle */
let _spotlightResizeObserver = null;
let _spotlightScrollHandler = null;

/**
 * Tour step definitions.
 * Each step may declare a `target` CSS selector to highlight on the page.
 * If the target element is not found the step renders without a highlight.
 * @type {Array<{ title: string, body: string, target?: string }>}
 */
const STEPS = [
  {
    title: 'Welcome to LazyBrain',
    body:
      'LazyBrain is an HTML-native second brain for AI coding agents. ' +
      'It captures decisions, code structure, and references so agents ' +
      'can recall them before every task — no more re-litigating settled choices.',
  },
  {
    title: 'Knowledge graph',
    body:
      'The home page shows an interactive knowledge graph of your brain. ' +
      'Each dot is a note; edges link related notes. ' +
      'Click any node to open it, or open the full graph for a bird\'s-eye view.',
    target: '.home-graph-panel',
  },
  {
    title: 'The sidebar',
    body:
      'The left panel shows your project tree. ' +
      'Every project, module, and file captured by LazyBrain appears here. ' +
      'Click any entry to open its knowledge note.',
    target: '#sidebar',
  },
  {
    title: 'Search',
    body:
      'The search bar at the top queries all notes full-text. ' +
      'You can also filter by type, project, or date after a search. ' +
      'Agents use the same endpoint to recall context automatically.',
    target: '#search-input',
  },
  {
    title: 'Browse topics',
    body:
      'The home page lists all top-level topics so you can browse by project or domain. ' +
      'Click a topic to see every note under it, sorted by relevance.',
    target: '.home-topics-section',
  },
  {
    title: "You're ready",
    body:
      'Browse topics, search for anything, or open a project note from the sidebar. ' +
      'As agents capture more memory, the brain grows automatically. ' +
      'You can relaunch this tour any time from the home page.',
  },
];

// --- Public API -------------------------------------------------------------

/**
 * Start the guided tour from step 0.
 * Idempotent — calling multiple times replaces the existing tour.
 */
export function startTour() {
  currentStep = 0;
  mountOverlay();
  renderStep(currentStep);
}

/**
 * Check whether the tour has been permanently dismissed by the user.
 * @returns {boolean}
 */
export function isTourDismissed() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

// --- Overlay lifecycle ------------------------------------------------------

/** Keyboard handler registered on document while tour is open. Removed on close. */
let _docKeyHandler = null;

function mountOverlay() {
  // Remove any pre-existing tour
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler);
    _docKeyHandler = null;
  }

  overlay = document.createElement('div');
  overlay.id = 'lazybrain-tour-overlay';
  // tabindex="-1" makes the overlay focusable so overlay.focus() and the
  // overlay keydown listener both work reliably.
  overlay.setAttribute('tabindex', '-1');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Guided tour');

  // Backdrop click dismisses the tour
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismissTour();
  });

  // Keyboard: Escape = dismiss, ArrowRight / ArrowLeft = next / prev
  // Listening on the overlay element (requires overlay to be focused or for
  // events to bubble up from focused children inside it).
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismissTour();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      advanceStep(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      advanceStep(-1);
    }
  });

  // Document-level Escape handler as a fallback so Escape always closes the
  // tour even if focus is somehow outside the overlay (e.g. a highlighted
  // target element grabbed focus).
  _docKeyHandler = (e) => {
    if (e.key === 'Escape' && overlay) {
      dismissTour();
    }
  };
  document.addEventListener('keydown', _docKeyHandler);

  document.body.appendChild(overlay);

  // overlay now has tabindex="-1" so focus() reliably moves keyboard focus
  // inside the dialog, enabling the overlay keydown listener immediately.
  overlay.focus();
}

function unmountOverlay() {
  if (_docKeyHandler) {
    document.removeEventListener('keydown', _docKeyHandler);
    _docKeyHandler = null;
  }
  removeSpotlight();
  if (overlay) {
    clearHighlights();
    overlay.remove();
    overlay = null;
  }
}

// --- Step rendering ---------------------------------------------------------

/**
 * Render a single tour step into the overlay.
 * @param {number} index
 */
function renderStep(index) {
  if (!overlay) return;

  const step = STEPS[index];
  if (!step) return;

  const isFirst = index === 0;
  const isLast = index === STEPS.length - 1;

  const progressDots = STEPS.map((_, i) => {
    const active = i === index ? ' tour-dot--active' : '';
    return `<span class="tour-dot${active}" aria-hidden="true"></span>`;
  }).join('');

  overlay.innerHTML = `
    <div class="tour-card" role="document">
      <header class="tour-card-header">
        <span class="tour-progress">${index + 1} / ${STEPS.length}</span>
        <button class="tour-close" type="button" data-tour-action="dismiss"
                aria-label="Close tour">&#215;</button>
      </header>

      <h2 class="tour-step-title">${escapeText(step.title)}</h2>
      <p class="tour-step-body">${escapeText(step.body)}</p>

      <div class="tour-dots" aria-hidden="true">${progressDots}</div>

      <footer class="tour-card-footer">
        <button class="tour-btn tour-btn--ghost"
                type="button"
                data-tour-action="dismiss">
          Skip tour
        </button>
        <div class="tour-nav">
          ${!isFirst ? `<button class="tour-btn tour-btn--secondary"
                                type="button"
                                data-tour-action="prev"
                                aria-label="Previous step">
                          Prev
                        </button>` : ''}
          <button class="tour-btn tour-btn--primary"
                  type="button"
                  data-tour-action="${isLast ? 'finish' : 'next'}"
                  aria-label="${isLast ? 'Finish tour' : 'Next step'}">
            ${isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </footer>
    </div>
  `;

  // Delegate all button actions — no inline handlers
  overlay.querySelector('.tour-card').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tour-action]');
    if (!btn) return;
    const action = btn.dataset.tourAction;
    handleAction(action);
  });

  // Highlight target element if present
  highlightTarget(step.target);

  // Auto-focus the primary button for keyboard users
  const primary = overlay.querySelector('[data-tour-action="next"], [data-tour-action="finish"]');
  primary?.focus();
}

// --- Actions ----------------------------------------------------------------

/**
 * Handle a named tour action.
 * @param {string} action
 */
function handleAction(action) {
  switch (action) {
    case 'next':
      advanceStep(1);
      break;
    case 'prev':
      advanceStep(-1);
      break;
    case 'finish':
      persistDismissal();
      unmountOverlay();
      break;
    case 'dismiss':
      dismissTour();
      break;
    default:
      break;
  }
}

/**
 * Move to the next or previous step, clamped to valid range.
 * @param {number} delta — +1 for next, -1 for prev
 */
function advanceStep(delta) {
  const next = currentStep + delta;
  if (next < 0 || next >= STEPS.length) return;
  currentStep = next;
  clearHighlights();
  renderStep(currentStep);
}

/**
 * Dismiss the tour without persisting (user can see it again next visit).
 */
function dismissTour() {
  unmountOverlay();
}

/**
 * Persist dismissal — tour will not auto-show again.
 */
function persistDismissal() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // localStorage may be unavailable in some contexts — non-fatal
  }
}

// --- Target highlighting + spotlight ----------------------------------------

/**
 * Highlight a DOM element corresponding to the step target selector and
 * position the spotlight window over it.
 * @param {string|undefined} selector
 */
function highlightTarget(selector) {
  clearHighlights();

  if (!selector) {
    // No target: fall back to full-screen dim on the overlay itself.
    overlay?.classList.add('tour-overlay--no-target');
    removeSpotlight();
    return;
  }

  const target = document.querySelector(selector);
  if (!target) {
    overlay?.classList.add('tour-overlay--no-target');
    removeSpotlight();
    return;
  }

  overlay?.classList.remove('tour-overlay--no-target');
  target.classList.add('tour-highlight');

  // Scroll target into view, then position spotlight after the scroll settles.
  target.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });

  // Give scrollIntoView time to settle (smooth scroll is async).
  // We position immediately (no flicker) and then re-position after the scroll
  // animation has had time to complete.
  positionSpotlight(target);
  setTimeout(() => positionSpotlight(target), 350);

  // Re-position on window resize.
  teardownSpotlightTracking();
  if (typeof ResizeObserver !== 'undefined') {
    _spotlightResizeObserver = new ResizeObserver(() => positionSpotlight(target));
    _spotlightResizeObserver.observe(target);
    _spotlightResizeObserver.observe(document.documentElement);
  }
  _spotlightScrollHandler = () => positionSpotlight(target);
  window.addEventListener('scroll', _spotlightScrollHandler, { passive: true });
}

/**
 * Create or reposition the spotlight element over a target.
 * @param {HTMLElement} target
 */
function positionSpotlight(target) {
  const rect = target.getBoundingClientRect();
  const padding = 6; // match outline-offset so the ring stays inside the spotlight
  const top = rect.top - padding;
  const left = rect.left - padding;
  const width = rect.width + padding * 2;
  const height = rect.height + padding * 2;

  if (!spotlight) {
    spotlight = document.createElement('div');
    spotlight.id = 'lazybrain-tour-spotlight';
    document.body.appendChild(spotlight);
  }

  spotlight.style.top = `${top}px`;
  spotlight.style.left = `${left}px`;
  spotlight.style.width = `${width}px`;
  spotlight.style.height = `${height}px`;
}

/**
 * Remove the spotlight element and its tracking listeners.
 */
function removeSpotlight() {
  teardownSpotlightTracking();
  if (spotlight) {
    spotlight.remove();
    spotlight = null;
  }
}

/**
 * Remove resize/scroll listeners used to track the spotlight target.
 */
function teardownSpotlightTracking() {
  if (_spotlightResizeObserver) {
    _spotlightResizeObserver.disconnect();
    _spotlightResizeObserver = null;
  }
  if (_spotlightScrollHandler) {
    window.removeEventListener('scroll', _spotlightScrollHandler);
    _spotlightScrollHandler = null;
  }
}

function clearHighlights() {
  for (const el of document.querySelectorAll('.tour-highlight')) {
    el.classList.remove('tour-highlight');
  }
}

// --- Utility ----------------------------------------------------------------

/**
 * Escape a string for safe text insertion (no HTML tags allowed in step content).
 * Uses a throwaway element — same approach as escapeHtml in shared.js but
 * kept local to avoid a circular dependency.
 * @param {string} str
 * @returns {string}
 */
function escapeText(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
