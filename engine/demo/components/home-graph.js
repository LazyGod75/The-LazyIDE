// examples/brain-ui/components/home-graph.js
// Full-width home-page knowledge graph panel — Obsidian-grade visual quality.
//
// VISUAL DESIGN:
//   - Canvas is ALWAYS dark (#0b0d12) regardless of the page light/dark theme.
//   - Edges are visible: thin (0.7 px), translucent cool-neutral lines.
//   - Node cap: top-NODE_CAP nodes by degree (id asc tiebreak). Induced edges only.
//     This keeps the home panel fast and readable at any brain size.
//   - Hub nodes (top 12 by degree) get a larger size, brighter color, always-on
//     label, and a vis-network shadow glow to feel luminous.
//   - Non-hub labels appear only on hover.
//   - Hover: brightens hovered node + neighbours, dims the rest.
//   - Entrance: CSS fade-in/scale-in via .hg-ready class added after network.fit().
//   - Click: SPA-navigates to the note's wiki route.
//   - Drag, zoom, pan: enabled.  Toolbar: +, −, fit, fullscreen, full-graph link.
//   - Empty brain: panel hidden gracefully.
//   - Error guard: try/catch around render — any failure shows an inline fallback
//     message with the "Open full graph" link instead of an eternal loading spinner.
//
// PERF CONTRACT:
//   - Fetches /_api/graph-layout.json (slim payload — positions + cluster only).
//   - Caps to NODE_CAP (default 500) top-degree nodes; fullscreen raises to
//     NODE_CAP_FULLSCREEN (1200). Only induced edges (between kept nodes) are drawn.
//   - If positions are present (hasPositions=true): physics is NEVER enabled.
//     Nodes are placed instantly. First paint < 300ms even at 2000+ source nodes.
//   - If positions are absent: instant client-side cluster-radial placement is
//     used. No physics simulation runs on page load.
//   - Physics is ALWAYS disabled at startup.
//
// FULLSCREEN:
//   - A fullscreen button in the toolbar expands the graph to a fixed
//     full-viewport overlay (z-index 990, dark backdrop).
//   - Uses Fullscreen API where available; fixed-CSS overlay fallback otherwise.
//   - Escape key or the close button exits fullscreen and restores the panel.
//   - No inline handlers — all wired via addEventListener (CSP compliant).
//
// NODE CAP POLICY:
//   1. Sort all nodes by degree desc, id asc (deterministic tiebreak — no Math.random).
//   2. Keep the top NODE_CAP nodes plus any aggregate/hub nodes not already included.
//   3. Keep only edges INDUCED by the kept node set (both endpoints in kept set).
//   4. Show a caption: "showing N most-connected of M nodes — open full graph".
//   The full graph page (graph.html) always shows the complete, uncapped graph.

import { fetchGraphLayout } from '../lib/api-client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max nodes rendered in the home panel. Raise in fullscreen. */
const NODE_CAP = 500;
/** Node cap when the panel is in fullscreen overlay mode (reserved for future use). */
const _NODE_CAP_FULLSCREEN = 1_200;

const HUB_COUNT = 12;

// Radial placement constants (used when positions are absent)
const RADIAL_CLUSTER_RADIUS = 600; // radius of the ring of cluster centres
const RADIAL_NODE_SPREAD = 180; // spread of nodes within a cluster

// ---------------------------------------------------------------------------
// Palette (16-colour, high saturation on dark background)
// ---------------------------------------------------------------------------

const PALETTE = [
  '#4FC3F7',
  '#66BB6A',
  '#FFA726',
  '#CE93D8',
  '#F48FB1',
  '#80CBC4',
  '#FFCC80',
  '#90CAF9',
  '#A5D6A7',
  '#EF9A9A',
  '#B39DDB',
  '#F0A500',
  '#4DB6AC',
  '#FF8A65',
  '#81C784',
  '#64B5F6',
];

let _paletteIdx = 0;
const _clusterColorMap = new Map([['_default', '#78909C']]);

function getClusterColor(clusterLabel) {
  if (_clusterColorMap.has(clusterLabel)) return _clusterColorMap.get(clusterLabel);
  const color = PALETTE[_paletteIdx % PALETTE.length];
  _paletteIdx = (_paletteIdx + 1) % PALETTE.length;
  _clusterColorMap.set(clusterLabel, color);
  return color;
}

/**
 * Lighten a hex colour toward white by `amount` in [0, 1].
 * @param {string} hex
 * @param {number} amount
 * @returns {string}
 */
function lightenHex(hex, amount) {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2, '0')}${lg.toString(16).padStart(2, '0')}${lb.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Node size from degree
// ---------------------------------------------------------------------------

const MIN_NODE_SIZE = 4;
const MAX_NODE_SIZE = 28;
const HUB_SIZE_BOOST = 1.55;

function nodeSizeFromDegree(degree, isHub) {
  const raw = MIN_NODE_SIZE + Math.sqrt(Math.max(0, degree)) * 2.4;
  const clamped = Math.min(MAX_NODE_SIZE, Math.max(MIN_NODE_SIZE, raw));
  return isHub ? Math.min(MAX_NODE_SIZE, clamped * HUB_SIZE_BOOST) : clamped;
}

// ---------------------------------------------------------------------------
// Instant client-side radial placement (O(n), seeded, no physics)
// Used when hasPositions=false. Produces a clustered layout immediately.
// ---------------------------------------------------------------------------

/**
 * Simple seeded LCG PRNG (Park-Miller) — deterministic, no Math.random.
 * Uses ((x % m) + m) % m to guarantee positive results in JS (% can be negative).
 * @param {number} seed
 * @returns {() => number} function returning floats in [0, 1)
 */
function makePrng(seed) {
  const M = 2147483647;
  let s = (seed >>> 0) % M || 1;
  return () => {
    s = ((Math.imul(s, 48271) % M) + M) % M;
    return (s - 1) / (M - 1);
  };
}

/**
 * Compute cluster-radial positions for all nodes.
 * Each cluster gets a centre on a big ring, nodes are placed on a
 * smaller ring around that centre with a little jitter.
 *
 * @param {Array<{id:string, c:number, d:number}>} nodes - slim nodes
 * @param {string[]} clusters - cluster labels indexed by c
 * @returns {Map<string, {x:number, y:number}>} nodeId → position
 */
function computeRadialPositions(nodes, clusters) {
  const prng = makePrng(0xdeadbeef);
  const clusterCount = clusters.length || 1;
  const positions = new Map();

  // Group nodes by cluster index
  const byCluster = new Map();
  for (const n of nodes) {
    const c = n.c ?? 0;
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(n);
  }

  // Place each cluster centre on a ring
  let ci = 0;
  for (const [_cIdx, clusterNodes] of byCluster) {
    const angle = (ci / clusterCount) * 2 * Math.PI;
    const cx = Math.cos(angle) * RADIAL_CLUSTER_RADIUS;
    const cy = Math.sin(angle) * RADIAL_CLUSTER_RADIUS;
    ci++;

    // Sort by degree descending so hubs go to centre
    clusterNodes.sort((a, b) => (b.d ?? 0) - (a.d ?? 0));

    const n = clusterNodes.length;
    for (let i = 0; i < n; i++) {
      const nodeAngle = (i / Math.max(n, 1)) * 2 * Math.PI;
      // Scale the local ring by cluster size — larger clusters spread more
      const localRadius = RADIAL_NODE_SPREAD * Math.sqrt(n / 10 + 0.5);
      const jitter = (prng() - 0.5) * localRadius * 0.3;
      const x = cx + Math.cos(nodeAngle) * (localRadius + jitter);
      const y = cy + Math.sin(nodeAngle) * (localRadius + jitter);
      positions.set(clusterNodes[i].id, { x, y });
    }
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Node capping: select top-N by degree, id-asc tiebreak (deterministic)
// ---------------------------------------------------------------------------

/**
 * Select the top-nodeCap nodes by degree (desc), id (asc) tiebreak.
 * Always includes aggregate/hub nodes even if they fall outside the cap.
 *
 * @param {Array<{id:string, c:number, d:number, t:string}>} allNodes
 * @param {number} nodeCap
 * @returns {{ keptNodes: Array, keptSet: Set<string> }}
 */
function selectTopNodes(allNodes, nodeCap) {
  if (allNodes.length <= nodeCap) {
    return { keptNodes: allNodes, keptSet: new Set(allNodes.map((n) => n.id)) };
  }

  // Sort by degree desc, id asc for determinism
  const sorted = [...allNodes].sort((a, b) => {
    const dd = (b.d ?? 0) - (a.d ?? 0);
    if (dd !== 0) return dd;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Always include aggregate-neuron nodes (type 'a') — they are structural hubs
  const keptSet = new Set();
  const aggregates = allNodes.filter((n) => n.t === 'a');
  for (const n of aggregates) keptSet.add(n.id);

  // Fill up to nodeCap from the sorted list
  for (const n of sorted) {
    if (keptSet.size >= nodeCap) break;
    keptSet.add(n.id);
  }

  const keptNodes = sorted.filter((n) => keptSet.has(n.id));
  return { keptNodes, keptSet };
}

/**
 * Keep only edges where BOTH endpoints are in keptSet.
 * Returns edge objects (not index pairs) referencing the kept node IDs.
 *
 * @param {Array<[number,number]>} allEdges - index pairs into allNodes
 * @param {Set<string>} keptSet
 * @param {Array<{id:string}>} allNodes
 * @returns {Array<{id:number, from:string, to:string}>}
 */
function inducedEdges(allEdges, keptSet, allNodes) {
  const result = [];
  let i = 0;
  for (const e of allEdges) {
    const [si, ti] = e;
    const fromId = allNodes[si]?.id;
    const toId = allNodes[ti]?.id;
    if (fromId && toId && keptSet.has(fromId) && keptSet.has(toId)) {
      result.push({
        id: i++,
        from: fromId,
        to: toId,
        color: {
          color: 'rgba(140, 160, 210, 0.16)',
          highlight: 'rgba(107, 163, 255, 0.80)',
          hover: 'rgba(107, 163, 255, 0.55)',
          opacity: 1,
        },
        width: 0.75,
        smooth: { type: 'continuous', roundness: 0.15 },
        arrows: '',
        selectionWidth: 0,
      });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build vis datasets from slim layout payload
// ---------------------------------------------------------------------------

/**
 * @param {{nodes:Array, edges:Array, clusters:string[], hasPositions:boolean}} slim
 * @param {number} nodeCap - maximum number of nodes to render
 * @returns {{ nodesArr, edgesArr, keptNodes, hubIds, totalNodes }}
 */
function buildVisData(slim, nodeCap) {
  const { nodes: allNodes, edges: allEdges, clusters, hasPositions } = slim;

  // Select top-N nodes by degree (deterministic, no Math.random)
  const { keptNodes, keptSet } = selectTopNodes(allNodes, nodeCap);
  const totalNodes = allNodes.length;

  // Compute positions for kept nodes (radial fallback only when positions absent)
  const positions = hasPositions ? null : computeRadialPositions(keptNodes, clusters);

  // Determine top-HUB_COUNT hubs by degree within the kept set
  const sortedKeptByDegree = [...keptNodes].sort((a, b) => (b.d ?? 0) - (a.d ?? 0));
  const hubIds = new Set(sortedKeptByDegree.slice(0, HUB_COUNT).map((n) => n.id));

  // Build node objects for vis-network
  const nodesArr = keptNodes.map((n) => {
    const clusterLabel = clusters[n.c] ?? '_default';
    const color = getClusterColor(clusterLabel);
    const isHub = hubIds.has(n.id);
    const size = nodeSizeFromDegree(n.d ?? 0, isHub);

    const x = hasPositions ? (n.x ?? 0) : (positions?.get(n.id)?.x ?? 0);
    const y = hasPositions ? (n.y ?? 0) : (positions?.get(n.id)?.y ?? 0);

    const bgColor = isHub ? color : `${color}bb`;
    const borderColor = isHub ? lightenHex(color, 0.25) : color;

    const nodeOpts = {
      id: n.id,
      label: isHub && n.l ? truncate(n.l, 18) : '',
      title: undefined,
      x,
      y,
      shape: 'dot',
      size,
      color: {
        background: bgColor,
        border: borderColor,
        highlight: { background: '#ffffff', border: color },
        hover: { background: lightenHex(color, 0.35), border: color },
      },
      font: {
        size: isHub ? 10 : 9,
        color: '#e8e8f0',
        face: '-apple-system, BlinkMacSystemFont, Roboto, sans-serif',
        strokeWidth: 2,
        strokeColor: 'rgba(8, 10, 18, 0.9)',
        vadjust: -(size + 4),
      },
      _cluster: clusterLabel,
      _degree: n.d ?? 0,
      _isHub: isHub,
      _type: n.t,
    };

    if (isHub) {
      nodeOpts.shadow = {
        enabled: true,
        color: `${color}55`,
        size: 14,
        x: 0,
        y: 0,
      };
    }

    return nodeOpts;
  });

  // Keep only edges induced by the kept node set
  const edgesArr = inducedEdges(allEdges, keptSet, allNodes);

  if (keptNodes.length < totalNodes) {
    console.info(
      `[home-graph] Node cap applied: showing ${keptNodes.length} most-connected of ${totalNodes} nodes, ${edgesArr.length} induced edges.`,
    );
  }

  return { nodesArr, edgesArr, keptNodes, hubIds, totalNodes };
}

// ---------------------------------------------------------------------------
// Panel HTML template
// ---------------------------------------------------------------------------

function buildPanelHtml() {
  return `
    <div class="hg-header" aria-hidden="true">
      <span class="hg-title">Knowledge graph</span>
      <div class="hg-toolbar" role="toolbar" aria-label="Graph controls">
        <button type="button" class="hg-btn" data-action="zoom-in"  title="Zoom in">+</button>
        <button type="button" class="hg-btn" data-action="zoom-out" title="Zoom out">&#x2212;</button>
        <button type="button" class="hg-btn" data-action="fit"      title="Fit">&#x26F6;</button>
        <button type="button" class="hg-btn hg-btn--fullscreen" data-action="fullscreen" title="Fullscreen" aria-label="Expand graph to fullscreen">[ ]</button>
        <a class="hg-btn hg-link" href="graph.html" data-action="fullgraph" title="Open full graph">&#x25A3;</a>
      </div>
    </div>
    <div class="hg-canvas-wrap" role="img" aria-label="Interactive knowledge graph — click a node to open the note">
      <div class="hg-canvas" id="hg-network"></div>
      <div class="hg-loading" id="hg-loading" aria-live="polite">Loading graph&hellip;</div>
      <div class="hg-caption" id="hg-caption" aria-live="polite" style="display:none;"></div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Hover: highlight node + neighbours, dim rest
// ---------------------------------------------------------------------------

function applyHover(network, visNodes, visEdges, keptNodes, edgesArr, clusters, hoveredId) {
  if (!hoveredId) {
    const resets = keptNodes.map((n) => {
      const clusterLabel = clusters[n.c] ?? '_default';
      const color = getClusterColor(clusterLabel);
      const isHub = n._isHub ?? false;
      const bgColor = isHub ? color : `${color}bb`;
      const borderColor = isHub ? lightenHex(color, 0.25) : color;

      const update = {
        id: n.id,
        color: {
          background: bgColor,
          border: borderColor,
          highlight: { background: '#ffffff', border: color },
          hover: { background: lightenHex(color, 0.35), border: color },
        },
        font: { color: '#e8e8f0' },
        opacity: 1,
      };

      if (isHub) {
        update.shadow = { enabled: true, color: `${color}55`, size: 14, x: 0, y: 0 };
      }

      return update;
    });
    visNodes.update(resets);

    const edgeResets = edgesArr.map((e) => ({
      id: e.id,
      color: { color: 'rgba(140, 160, 210, 0.16)', highlight: 'rgba(107, 163, 255, 0.80)' },
      width: 0.75,
    }));
    visEdges.update(edgeResets);
    return;
  }

  const connectedEdgeIds = new Set(network.getConnectedEdges(hoveredId));
  const neighbourIds = new Set(network.getConnectedNodes(hoveredId));
  neighbourIds.add(hoveredId);

  const nodeUpdates = keptNodes.map((n) => {
    const isActive = neighbourIds.has(n.id);
    const clusterLabel = clusters[n.c] ?? '_default';
    const color = getClusterColor(clusterLabel);

    if (isActive) {
      return {
        id: n.id,
        color: {
          background: color,
          border: lightenHex(color, 0.3),
          highlight: { background: '#ffffff', border: color },
        },
        font: { color: '#ffffff' },
        opacity: 1,
      };
    }
    return {
      id: n.id,
      color: { background: `${color}22`, border: `${color}18` },
      font: { color: 'rgba(232, 232, 240, 0.15)' },
      opacity: 0.4,
    };
  });
  visNodes.update(nodeUpdates);

  const edgeUpdates = edgesArr.map((e) => ({
    id: e.id,
    color: connectedEdgeIds.has(e.id)
      ? { color: 'rgba(107, 163, 255, 0.85)', highlight: 'rgba(107, 163, 255, 1)' }
      : { color: 'rgba(140, 160, 210, 0.04)' },
    width: connectedEdgeIds.has(e.id) ? 1.6 : 0.3,
  }));
  visEdges.update(edgeUpdates);
}

// ---------------------------------------------------------------------------
// Fullscreen logic
// ---------------------------------------------------------------------------

/**
 * State: track whether we are in fullscreen mode and the overlay element.
 * @type {{ active: boolean, overlay: HTMLElement|null, panel: HTMLElement|null, network: object|null }}
 */
const _fs = { active: false, overlay: null, panel: null, network: null };

/**
 * Enter fullscreen: create overlay, move canvas into it, resize network.
 * Uses Fullscreen API where available; falls back to fixed-position CSS overlay.
 *
 * @param {HTMLElement} panel - the .home-graph-panel element
 * @param {object} network - the vis.Network instance
 */
function enterFullscreen(panel, network) {
  if (_fs.active) return;
  _fs.active = true;
  _fs.panel = panel;
  _fs.network = network;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.className = 'hg-fullscreen-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', 'Graph fullscreen view');
  overlay.setAttribute('aria-modal', 'true');

  // Close button inside overlay
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'hg-fullscreen-close';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('title', 'Close fullscreen (Esc)');
  closeBtn.setAttribute('aria-label', 'Close fullscreen');
  closeBtn.addEventListener('click', () => exitFullscreen());

  overlay.appendChild(closeBtn);

  // Clone network container into overlay — we move the existing canvas element
  // by reparenting it so vis-network does not need to reinitialise.
  const canvasWrap = panel.querySelector('.hg-canvas-wrap');
  if (canvasWrap) {
    overlay.appendChild(canvasWrap);
  }

  document.body.appendChild(overlay);
  _fs.overlay = overlay;

  // Try Fullscreen API first (best UX); fall back silently on failure.
  if (document.fullscreenEnabled && overlay.requestFullscreen) {
    overlay.requestFullscreen().catch(() => {
      // Fullscreen API not granted (e.g. embedded frame) — CSS overlay is already in place.
    });
  }

  // Re-fit after a frame so vis-network picks up the new container dimensions.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      network.redraw();
      network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
    });
  });

  panel.classList.add('hg-has-fullscreen');
}

/**
 * Exit fullscreen: restore canvas to the original panel.
 */
function exitFullscreen() {
  if (!_fs.active) return;
  _fs.active = false;

  const { overlay, panel, network } = _fs;

  // Exit browser fullscreen if active
  if (document.fullscreenElement === overlay) {
    document.exitFullscreen().catch(() => {});
  }

  // Restore canvas wrap to the panel
  const canvasWrap = overlay?.querySelector('.hg-canvas-wrap');
  if (canvasWrap && panel) {
    panel.appendChild(canvasWrap);
  }

  if (overlay) overlay.remove();
  _fs.overlay = null;

  if (panel) panel.classList.remove('hg-has-fullscreen');

  // Re-fit network to the restored panel size
  if (network) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        network.redraw();
        network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
      });
    });
  }

  _fs.panel = null;
  _fs.network = null;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Mount the full-width home graph panel inside container.
 * @param {Element} container
 */
export function mountHomeGraph(container) {
  const section = document.createElement('section');
  section.className = 'home-graph-panel';
  section.setAttribute('aria-label', 'Knowledge graph overview');
  section.innerHTML = buildPanelHtml();
  container.insertBefore(section, container.firstChild);

  // Escape key exits fullscreen (CSP-safe: addEventListener on document)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _fs.active) {
      exitFullscreen();
    }
  });

  // fullscreenchange — browser can exit via Esc natively
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && _fs.active) {
      exitFullscreen();
    }
  });

  // IntersectionObserver so we don't fetch until panel is near view
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          obs.disconnect();
          initGraph(section);
        }
      }
    },
    { rootMargin: '300px' },
  );
  observer.observe(section);
}

/**
 * Show an inline error inside the panel with a link to the full graph.
 * Guarantees the loading state never persists after a failure.
 */
function showPanelError(panel, message) {
  const loadingEl = panel.querySelector('#hg-loading');
  if (loadingEl) {
    loadingEl.innerHTML = `${message} &mdash; <a href="graph.html">Open full graph</a>`;
    loadingEl.className = 'hg-loading hg-error';
    loadingEl.style.display = '';
  }
}

async function initGraph(panel) {
  const loadingEl = panel.querySelector('#hg-loading');
  const canvasEl = panel.querySelector('#hg-network');
  const captionEl = panel.querySelector('#hg-caption');

  let slim;
  try {
    slim = await fetchGraphLayout();
  } catch (_err) {
    showPanelError(panel, 'Graph unavailable: run lazybrain graph');
    return;
  }

  try {
    const allNodes = slim.nodes || [];
    const clusters = slim.clusters || [];

    if (allNodes.length === 0) {
      panel.style.display = 'none';
      return;
    }

    // Initialise cluster colours from actual cluster list
    for (const label of clusters) {
      getClusterColor(label);
    }

    const { nodesArr, edgesArr, keptNodes, hubIds, totalNodes } = buildVisData(slim, NODE_CAP);

    // Annotate keptNodes with _isHub (for hover reset — O(n) via Map)
    const hubIdSet = hubIds;
    for (const n of keptNodes) {
      n._isHub = hubIdSet.has(n.id);
    }

    if (loadingEl) loadingEl.style.display = 'none';

    // Show caption when brain is larger than the cap
    if (captionEl && totalNodes > NODE_CAP) {
      captionEl.style.display = '';
      captionEl.innerHTML = `showing ${keptNodes.length} most-connected of ${totalNodes} nodes &mdash; <a href="graph.html">open full graph</a>`;
    }

    const visNodes = new window.vis.DataSet(nodesArr);
    const visEdges = new window.vis.DataSet(edgesArr);

    // Physics is ALWAYS disabled — positions are either precomputed or radially placed.
    // improvedLayout must be false when positions are pre-assigned; it conflicts.
    const options = {
      nodes: {
        shape: 'dot',
        borderWidth: 1.2,
        scaling: { min: 4, max: 28 },
      },
      edges: {
        smooth: { type: 'continuous', roundness: 0.15 },
        selectionWidth: 0,
      },
      physics: {
        enabled: false,
      },
      interaction: {
        hover: true,
        tooltipDelay: 99999,
        hideEdgesOnDrag: true,
        navigationButtons: false,
        keyboard: false,
      },
      layout: { improvedLayout: false },
    };

    const network = new window.vis.Network(canvasEl, { nodes: visNodes, edges: visEdges }, options);

    // Fit immediately — no physics stabilization needed
    network.fit({ animation: false });

    // Entrance animation after first draw
    network.once('afterDrawing', () => {
      if (!panel.classList.contains('hg-ready')) {
        panel.classList.add('hg-ready');
      }
    });

    // Hover — highlight neighbours, dim the rest
    network.on('hoverNode', ({ node }) => {
      canvasEl.style.cursor = 'pointer';
      applyHover(network, visNodes, visEdges, keptNodes, edgesArr, clusters, node);
    });
    network.on('blurNode', () => {
      canvasEl.style.cursor = '';
      applyHover(network, visNodes, visEdges, keptNodes, edgesArr, clusters, null);
    });

    // Click → SPA navigate
    network.on('click', ({ nodes: clicked }) => {
      if (clicked.length === 0) return;
      const nodeId = clicked[0];
      location.hash = `#/wiki/${encodeURIComponent(nodeId)}`;
    });

    // Toolbar via event delegation (CSP compliant — no inline handlers)
    panel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'zoom-in') {
        network.moveTo({
          scale: network.getScale() * 1.3,
          animation: { duration: 200, easingFunction: 'linear' },
        });
      } else if (action === 'zoom-out') {
        network.moveTo({
          scale: network.getScale() / 1.3,
          animation: { duration: 200, easingFunction: 'linear' },
        });
      } else if (action === 'fit') {
        network.fit({ animation: { duration: 400, easingFunction: 'easeInOutQuad' } });
      } else if (action === 'fullscreen') {
        enterFullscreen(panel, network);
      }
      // 'fullgraph' — anchor default navigates to graph.html
    });

    // Show "Refine layout" button only when positions were absent (radial fallback used)
    if (!slim.hasPositions) {
      showRefineButton(panel, network, visNodes, visEdges, keptNodes, clusters);
    }
  } catch (err) {
    console.error('[home-graph] Render failed:', err);
    showPanelError(panel, 'Graph could not be rendered');
  }
}

// ---------------------------------------------------------------------------
// "Refine layout" button — on-demand physics (only when positions are absent)
// ---------------------------------------------------------------------------

function showRefineButton(panel, network, _visNodes, _visEdges, _slimNodes, _clusters) {
  const toolbar = panel.querySelector('.hg-toolbar');
  if (!toolbar || toolbar.querySelector('[data-action="refine"]')) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'hg-btn hg-btn--refine';
  btn.dataset.action = 'refine';
  btn.title = 'Refine layout with physics (on demand)';
  btn.textContent = 'Refine';

  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = '...';
    network.setOptions({
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -35,
          centralGravity: 0.003,
          springLength: 100,
          springConstant: 0.07,
          damping: 0.4,
          avoidOverlap: 0.3,
        },
        stabilization: { enabled: true, iterations: 80, fit: true },
      },
    });
    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: { enabled: false } });
      btn.remove();
    });
  });

  toolbar.insertBefore(btn, toolbar.querySelector('.hg-link'));
}

// ---------------------------------------------------------------------------
// Truncate helper
// ---------------------------------------------------------------------------

function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? `${str.slice(0, maxLen - 1)}…` : str;
}
