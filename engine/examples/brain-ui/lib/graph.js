

// ========================================================================
// CLUSTER PALETTE — generated dynamically from actual topics
// ========================================================================

// Diverse color palette for dynamic cluster assignment (no hardcoded project names)
const PALETTE = [
  '#4FC3F7', '#66BB6A', '#FFA726', '#CE93D8',
  '#F48FB1', '#80CBC4', '#FFCC80', '#90CAF9',
  '#A5D6A7', '#EF9A9A', '#B39DDB', '#F0A500',
  '#4DB6AC', '#FF8A65', '#81C784', '#64B5F6',
];

// Runtime cluster-to-color map (populated after graph data loads)
const clusterColorMap = new Map([['_default', '#78909C']]);
let paletteIdx = 0;

function getOrAssignClusterColor(cluster) {
  if (clusterColorMap.has(cluster)) return clusterColorMap.get(cluster);
  const color = PALETTE[paletteIdx % PALETTE.length];
  paletteIdx++;
  clusterColorMap.set(cluster, color);
  return color;
}

function clusterOf(topic) {
  if (!topic) return '_default';
  return topic.split('/')[0].toLowerCase();
}

function colorOf(cluster) {
  return clusterColorMap.get(cluster) || clusterColorMap.get('_default');
}

/**
 * Initialise the cluster→color map from a list of raw nodes.
 * Called once after graph data loads.
 * @param {Array} rawNodes
 */
function buildClusterColors(rawNodes) {
  const seen = new Set();
  for (const n of rawNodes) {
    const c = clusterOf(n.topic);
    if (!seen.has(c)) {
      seen.add(c);
      getOrAssignClusterColor(c);
    }
  }
}

// Node type shape/size modifiers for code-first neurons
function nodeShapeFor(type) {
  switch (type) {
    case 'file-neuron':      return 'dot';
    case 'aggregate-neuron': return 'square';
    case 'concept':          return 'diamond';
    default:                 return 'dot';
  }
}

// Size multiplier for aggregate-neurons (they represent modules)
function nodeSizeMultiplier(type) {
  switch (type) {
    case 'aggregate-neuron': return 1.6;
    case 'concept':          return 1.3;
    default:                 return 1.0;
  }
}

// ========================================================================
// STATE
// ========================================================================
const state = {
  rawNodes: [],
  rawEdges: [],
  network: null,
  visNodes: null,
  visEdges: null,
  searchQuery: '',
  activeEdgeTypes: new Set(['EXTRACTED', 'INFERRED', 'AMBIGUOUS']),
  minConfidence: 0,
  activeCluster: null,      // cluster filter from legend click
  pathHighlight: new Set(), // node IDs in highlighted path
  selectedNodeId: null,
  /** True when the graph was loaded with precomputed positions (physics off by default). */
  hasPrecomputedLayout: false,
};

// ========================================================================
// EDGE STYLE HELPERS
// ========================================================================
function edgeDashes(type) {
  const t = (type || '').toUpperCase();
  if (t === 'EXTRACTED') return false;
  if (t === 'INFERRED')  return [6, 4];
  return [2, 4]; // AMBIGUOUS or unknown → dotted
}

function edgeWidth(confidence) {
  const c = Number.parseFloat(confidence) || 0.5;
  return Math.max(0.5, c * 3);
}

// ========================================================================
// BUILD VIS DATASETS
// ========================================================================
function buildVisNodes(rawNodes) {
  const degreeCounts = new Map();
  for (const e of state.rawEdges) {
    degreeCounts.set(e.from, (degreeCounts.get(e.from) || 0) + 1);
    degreeCounts.set(e.to,   (degreeCounts.get(e.to)   || 0) + 1);
  }

  return rawNodes.map((n) => {
    const cluster   = clusterOf(n.topic);
    const color     = colorOf(cluster);
    // Prefer degree from precomputed data; fall back to edge-list count
    const degree    = (typeof n.degree === 'number' ? n.degree : null) ?? degreeCounts.get(n.id) ?? 0;
    const pagerank  = n.importance || 0.5;
    const sizeMult  = nodeSizeMultiplier(n.type);
    const size      = (6 + Math.sqrt(degree) * 3 + pagerank * 8) * sizeMult;
    const shape     = nodeShapeFor(n.type);

    const visNode = {
      id:    n.id,
      label: n.title,
      title: buildNodeTooltip(n, degree),
      shape,
      color: {
        background: color,
        border: color,
        highlight: { background: '#ffffff', border: color },
        hover:      { background: lighten(color), border: '#ffffff' },
      },
      size,
      font: {
        size: 11,
        color: '#e8e8f0',
        face: '-apple-system, BlinkMacSystemFont, Roboto, sans-serif',
        strokeWidth: 2,
        strokeColor: 'rgba(10, 10, 25, 0.7)',
      },
      // store extras for info panel
      _cluster: cluster,
      _degree: degree,
      _topic: n.topic,
      _type: n.type,
      _importance: pagerank,
      _id: n.id,
    };

    // Inject precomputed positions when available so vis-network skips physics
    if (typeof n.x === 'number' && typeof n.y === 'number') {
      visNode.x = n.x;
      visNode.y = n.y;
      visNode.fixed = false; // allow drag after positioning
    }

    return visNode;
  });
}

function buildVisEdges(rawEdges) {
  return rawEdges.map((e, i) => ({
    id: i,
    from: e.from,
    to: e.to,
    dashes: edgeDashes(e.type),
    width: edgeWidth(e.confidence),
    color: { color: 'rgba(180, 180, 220, 0.18)', highlight: 'rgba(107, 163, 255, 0.8)', hover: 'rgba(107, 163, 255, 0.6)' },
    _type: (e.type || '').toUpperCase(),
    _confidence: Number.parseFloat(e.confidence) || 0.5,
    smooth: { type: 'continuous' },
    arrows: '',
    selectionWidth: 2,
  }));
}

function buildNodeTooltip(n, degree) {
  const cluster = clusterOf(n.topic);
  const color   = colorOf(cluster);
  return `<div style="
    background: rgba(10,10,28,0.97);
    border: 1px solid ${color}55;
    border-radius: 8px;
    padding: 10px 13px;
    font-family: -apple-system,BlinkMacSystemFont,Roboto,sans-serif;
    font-size: 12px;
    max-width: 280px;
    line-height: 1.6;
    color: #e8e8f0;
  ">
    <div style="font-size:10px;color:${color};text-transform:uppercase;letter-spacing:.4px;">${escHtml(n.topic || cluster)}</div>
    <div style="font-weight:700;font-size:14px;margin-bottom:3px;">${escHtml(n.title)}</div>
    <div style="font-size:11px;color:#888;text-transform:uppercase;">${escHtml(n.type || '')}</div>
    <div style="font-size:11px;color:#aaa;">Connections: ${degree} &nbsp;·&nbsp; Importance: ${Math.round((n.importance||0.5)*100)}%</div>
  </div>`;
}

function lighten(hex) {
  // simple: push each channel 30% toward white
  const r = Number.parseInt(hex.slice(1,3), 16);
  const g = Number.parseInt(hex.slice(3,5), 16);
  const b = Number.parseInt(hex.slice(5,7), 16);
  const lr = Math.round(r + (255 - r) * 0.3);
  const lg = Math.round(g + (255 - g) * 0.3);
  const lb = Math.round(b + (255 - b) * 0.3);
  return `#${lr.toString(16).padStart(2,'0')}${lg.toString(16).padStart(2,'0')}${lb.toString(16).padStart(2,'0')}`;
}

// ========================================================================
// GRAPH INIT
// ========================================================================
async function loadGraph() {
  // Static mode: a <meta name="lazybrain-static"> tag is injected by `publish --site`.
  // Only try data/graph.json when that marker is present; otherwise go straight
  // to the live API — avoids a noisy 404 on every live `lazybrain serve` session.
  const isStatic = Boolean(document.querySelector('meta[name="lazybrain-static"]'));

  if (isStatic) {
    try {
      const staticRes = await fetch('data/graph.json');
      if (staticRes.ok) return staticRes.json();
    } catch (_) {
      // Not accessible (e.g. file:// CORS) — fall through to live API.
    }
  }

  const origin = window.location.origin;
  const res = await fetch(`${origin}/_api/graph.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} from /_api/graph.json`);
  return res.json();
}

/**
 * Load the slim layout payload first for fast position injection.
 * Returns null on failure (caller falls back gracefully).
 * @returns {Promise<object|null>}
 */
async function loadSlimLayout() {
  const isStatic = Boolean(document.querySelector('meta[name="lazybrain-static"]'));
  try {
    const url = isStatic ? 'data/graph-layout.json' : `${window.location.origin}/_api/graph-layout.json`;
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/**
 * Inject precomputed x/y positions from the slim payload into raw graph nodes.
 * This avoids re-fetching graph.json positions (they duplicate slim data).
 * @param {Array} rawNodes
 * @param {object} slim - slim layout payload
 */
function injectSlimPositions(rawNodes, slim) {
  if (!slim || !slim.hasPositions) return;
  const posMap = new Map(slim.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  for (const n of rawNodes) {
    const pos = posMap.get(n.id);
    if (pos) {
      n.x = pos.x;
      n.y = pos.y;
    }
  }
}

// ---------------------------------------------------------------------------
// Client-side radial fallback placement (O(n), seeded, zero physics)
// Used when no precomputed positions are available (brain not yet graphed).
// ---------------------------------------------------------------------------

/**
 * Simple seeded LCG PRNG (Park-Miller) — deterministic.
 * @param {number} seed
 * @returns {() => number}
 */
function makeGraphPrng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = Math.imul(s, 48271) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Assign x/y positions to rawNodes using cluster-radial placement.
 * Mutates rawNodes in place (positions are written as x/y on each node).
 * @param {Array<{id:string, topic?:string, cluster?:string, degree?:number}>} rawNodes
 */
function applyRadialFallback(rawNodes) {
  const RING_RADIUS = 700;
  const SPREAD = 200;
  const prng = makeGraphPrng(0xdeadbeef);

  // Group by cluster
  const byCluster = new Map();
  for (const n of rawNodes) {
    const c = n.cluster ?? (n.topic ? n.topic.split('/')[0].toLowerCase() : '_default');
    n._fallbackCluster = c;
    if (!byCluster.has(c)) byCluster.set(c, []);
    byCluster.get(c).push(n);
  }

  const clusterList = [...byCluster.keys()];
  const k = clusterList.length || 1;
  let ci = 0;

  for (const [cKey, nodes] of byCluster) {
    const angle = (ci / k) * 2 * Math.PI;
    const cx = Math.cos(angle) * RING_RADIUS;
    const cy = Math.sin(angle) * RING_RADIUS;
    ci++;

    // Sort by degree descending — hubs near centre
    nodes.sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0));
    const n = nodes.length;
    const localR = SPREAD * Math.sqrt(n / 10 + 0.5);

    for (let i = 0; i < n; i++) {
      const a2 = (i / Math.max(n, 1)) * 2 * Math.PI;
      const jitter = (prng() - 0.5) * localR * 0.3;
      nodes[i].x = cx + Math.cos(a2) * (localR + jitter);
      nodes[i].y = cy + Math.sin(a2) * (localR + jitter);
    }
  }
}

function initNetwork(container, visNodeArr, visEdgeArr) {
  state.visNodes = new vis.DataSet(visNodeArr);
  state.visEdges = new vis.DataSet(visEdgeArr);

  // Physics is always disabled at startup. Positions are either:
  //   (a) precomputed by lazybrain graph — baked into each node's x/y
  //   (b) absent → radial client-side placement is applied below before vis init
  // In both cases we never run a physics sim on page load (eliminates the 4.5s wait).
  const usePrecomputed = state.hasPrecomputedLayout;

  // When positions are absent, apply instant radial placement so vis-network
  // still paints a clustered layout with physics off.
  if (!usePrecomputed) {
    applyRadialFallback(state.rawNodes);
  }

  const options = {
    nodes: {
      shape: 'dot',
      borderWidth: 1.5,
      scaling: { min: 6, max: 40 },
    },
    edges: {
      smooth: { type: 'continuous', roundness: 0.2 },
      selectionWidth: 2,
    },
    physics: {
      enabled: false,
    },
    interaction: {
      hover: true,
      tooltipDelay: 150,
      hideEdgesOnDrag: true,
      hideEdgesOnZoom: false,
      navigationButtons: false,
      keyboard: false,  // we handle shortcuts manually
    },
    layout: {
      improvedLayout: false,
    },
    // Note: vis.Network does not accept a root-level `background` option.
    // The graph background is controlled via CSS on the #graph-network element.
  };

  state.network = new vis.Network(container, { nodes: state.visNodes, edges: state.visEdges }, options);

  // Fit immediately — physics is off, nodes are already positioned.
  state.network.fit({ animation: false });
  document.getElementById('loading-overlay').style.display = 'none';
  showRelayoutButton();

  // Node click → info panel
  state.network.on('click', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      showInfoPanel(nodeId);
    } else {
      // Click on empty space → clear selection but keep panel
    }
  });

  // Double-click → navigate to note or wiki (for code-first neurons)
  state.network.on('doubleClick', (params) => {
    if (params.nodes.length > 0) {
      const nodeId = params.nodes[0];
      const node = state.visNodes.get(nodeId);
      const type = node ? node._type : '';
      const isCodeNeuron = type === 'file-neuron' || type === 'aggregate-neuron' || type === 'concept';
      const route = isCodeNeuron ? `#/wiki/${encodeURIComponent(nodeId)}` : `#/note/${encodeURIComponent(nodeId)}`;
      window.open(`./${route}`, '_self');
    }
  });
}

// ========================================================================
// INFO PANEL
// ========================================================================
function showInfoPanel(nodeId) {
  const node = state.visNodes.get(nodeId);
  if (!node) return;

  state.selectedNodeId = nodeId;
  const color = colorOf(node._cluster);

  // Gather neighbors
  const neighborIds = state.network.getConnectedNodes(nodeId);

  const neighborsHtml = neighborIds.slice(0, 12).map((nid) => {
    const nb = state.visNodes.get(nid);
    if (!nb) return '';
    return `<div class="neighbor-chip" data-node-id="${escAttr(nid)}">${escHtml(nb.label || nid)}</div>`;
  }).join('');

  document.getElementById('info-body').innerHTML = `
    <div class="info-section">
      <div class="info-type-badge" style="background:${color}22;color:${color};">${escHtml(node._type || 'note')}</div>
      <div class="info-title">${escHtml(node.label || nodeId)}</div>
      <div style="font-size:11px;color:${color};margin-bottom:4px;">${escHtml(node._topic || node._cluster || '')}</div>
    </div>

    <div class="info-section">
      <div class="info-field-label">Cluster</div>
      <div class="info-field-value">${escHtml(node._cluster)}</div>
    </div>

    <div class="info-section">
      <div class="info-field-label">Degree · Importance</div>
      <div class="info-field-value">${node._degree} connections &nbsp;·&nbsp; ${Math.round((node._importance||0.5)*100)}%</div>
    </div>

    ${neighborIds.length > 0 ? `
    <div class="info-section">
      <div class="info-field-label">Neighbors (${Math.min(neighborIds.length, 12)} of ${neighborIds.length})</div>
      <div class="info-neighbors">${neighborsHtml}</div>
    </div>` : ''}

    <div class="info-section">
      ${(() => {
        const isCodeNeuron = node._type === 'file-neuron' || node._type === 'aggregate-neuron' || node._type === 'concept';
        const route = isCodeNeuron ? `#/wiki/${encodeURIComponent(nodeId)}` : `#/note/${encodeURIComponent(nodeId)}`;
        return `<a class="info-link" href="./${route}">Open in wiki &#8594;</a>`;
      })()}
    </div>
  `;

  // Wire neighbor clicks → focus that node
  document.querySelectorAll('.neighbor-chip[data-node-id]').forEach((el) => {
    el.addEventListener('click', () => {
      const nid = el.getAttribute('data-node-id');
      state.network.selectNodes([nid]);
      state.network.focus(nid, { animation: { duration: 400, easingFunction: 'easeInOutQuad' }, scale: 1 });
      showInfoPanel(nid);
    });
  });

  document.getElementById('info-panel').classList.add('visible');
}

function hideInfoPanel() {
  document.getElementById('info-panel').classList.remove('visible');
  state.selectedNodeId = null;
  if (state.network) state.network.unselectAll();
}

// ========================================================================
// SEARCH
// ========================================================================
function applySearch(query) {
  state.searchQuery = query.toLowerCase().trim();
  applyFilters();
}

// ========================================================================
// FILTERS (search + edge type + confidence + cluster)
// ========================================================================
function applyFilters() {
  const q          = state.searchQuery;
  const edgeTypes  = state.activeEdgeTypes;
  const minConf    = state.minConfidence;
  const cluster    = state.activeCluster;
  const pathNodes  = state.pathHighlight;
  const hasPath    = pathNodes.size > 0;

  // Node visibility / opacity updates
  const nodeUpdates = state.rawNodes.map((n) => {
    const nc = clusterOf(n.topic);
    let visible = true;

    if (q && !n.title.toLowerCase().includes(q)) visible = false;
    if (cluster && nc !== cluster) visible = false;

    // In path mode, only path nodes are fully visible
    let opacity = 1;
    if (hasPath) {
      opacity = pathNodes.has(n.id) ? 1 : 0.1;
    } else if (!visible) {
      opacity = 0.08;
    }

    const color = colorOf(nc);
    const alpha = Math.round(opacity * 255).toString(16).padStart(2, '0');

    return {
      id: n.id,
      hidden: false, // never truly hide — just fade
      color: {
        background: visible && opacity > 0.5 ? color : `${color}${alpha}`,
        border:     visible && opacity > 0.5 ? color : `${color}${alpha}`,
        highlight:  { background: '#ffffff', border: color },
        hover:      { background: lighten(color), border: '#ffffff' },
      },
    };
  });

  state.visNodes.update(nodeUpdates);

  // Edge visibility
  const edgeUpdates = state.rawEdges.map((e, i) => {
    const etype = (e.type || '').toUpperCase();
    const conf  = Number.parseFloat(e.confidence) || 0.5;
    const visible = edgeTypes.has(etype) && conf >= minConf;

    const inPath = hasPath && pathNodes.has(e.from) && pathNodes.has(e.to);

    let edgeColor;
    if (inPath) {
      edgeColor = { color: '#6ba3ff', highlight: '#89b9ff', hover: '#89b9ff', opacity: 1 };
    } else if (visible) {
      edgeColor = { color: 'rgba(180,180,220,0.18)', highlight: 'rgba(107,163,255,0.8)', hover: 'rgba(107,163,255,0.6)', opacity: 1 };
    } else {
      edgeColor = { color: 'rgba(180,180,220,0.03)', opacity: 0 };
    }

    return {
      id: i,
      hidden: !visible && !inPath,
      color: edgeColor,
      width: inPath ? 2.5 : edgeWidth(e.confidence),
    };
  });

  state.visEdges.update(edgeUpdates);
}

// ========================================================================
// PATH FINDER — BFS shortest path
// ========================================================================
function bfsShortestPath(fromId, toId) {
  if (fromId === toId) return [fromId];

  const visited = new Set([fromId]);
  const queue   = [[fromId]];
  const adjMap  = new Map();

  // Build adjacency from raw edges (undirected)
  for (const e of state.rawEdges) {
    if (!adjMap.has(e.from)) adjMap.set(e.from, []);
    if (!adjMap.has(e.to))   adjMap.set(e.to,   []);
    adjMap.get(e.from).push(e.to);
    adjMap.get(e.to).push(e.from);
  }

  while (queue.length > 0) {
    const path = queue.shift();
    const node = path[path.length - 1];
    const neighbors = adjMap.get(node) || [];

    for (const nb of neighbors) {
      if (nb === toId) return [...path, nb];
      if (!visited.has(nb)) {
        visited.add(nb);
        queue.push([...path, nb]);
      }
    }
  }
  return null; // no path found
}

function resolveNodeId(input) {
  const q = input.trim().toLowerCase();
  // Exact ID match first
  const direct = state.visNodes.get(q);
  if (direct) return q;
  // Title match
  const all = state.visNodes.get();
  const match = all.find((n) => (n.label || '').toLowerCase() === q);
  return match ? match.id : null;
}

function runPathFinder() {
  const fromInput = document.getElementById('path-from').value;
  const toInput   = document.getElementById('path-to').value;
  const resultEl  = document.getElementById('path-result');

  const fromId = resolveNodeId(fromInput);
  const toId   = resolveNodeId(toInput);

  if (!fromId || !toId) {
    resultEl.textContent = 'Could not resolve one or both node IDs.';
    resultEl.className = 'path-result not-found';
    return;
  }

  const path = bfsShortestPath(fromId, toId);

  state.pathHighlight.clear();

  if (!path) {
    resultEl.textContent = 'No path found between those nodes.';
    resultEl.className = 'path-result not-found';
    applyFilters();
    return;
  }

  for (const id of path) state.pathHighlight.add(id);

  const labels = path.map((id) => {
    const n = state.visNodes.get(id);
    return n ? (n.label || id) : id;
  });

  resultEl.innerHTML = `Path (${path.length} hops):<br>${labels.map(escHtml).join(' → ')}`;
  resultEl.className = 'path-result found';

  applyFilters();

  // Focus on path nodes
  state.network.fit({ nodes: path, animation: { duration: 600, easingFunction: 'easeInOutQuad' } });
}

function clearPath() {
  state.pathHighlight.clear();
  document.getElementById('path-result').textContent = '';
  document.getElementById('path-result').className = 'path-result';
  applyFilters();
}

// ========================================================================
// LEGEND
// ========================================================================
function buildLegend() {
  const counts = {};
  for (const n of state.rawNodes) {
    const c = clusterOf(n.topic);
    counts[c] = (counts[c] || 0) + 1;
  }

  const container = document.getElementById('legend-list');
  container.innerHTML = '';

  // Type legend (shapes)
  const typeLegend = document.createElement('div');
  typeLegend.className = 'legend-type-section';
  typeLegend.innerHTML = `
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;margin-bottom:6px;">Node Types</div>
    <div class="legend-item" style="pointer-events:none;">
      <div class="legend-dot" style="border-radius:50%;background:#78909C;"></div>
      <span class="legend-label">note / reference</span>
    </div>
    <div class="legend-item" style="pointer-events:none;">
      <div class="legend-dot" style="border-radius:2px;background:#78909C;"></div>
      <span class="legend-label">aggregate (module)</span>
    </div>
    <div class="legend-item" style="pointer-events:none;">
      <div class="legend-dot" style="transform:rotate(45deg);border-radius:2px;background:#78909C;"></div>
      <span class="legend-label">concept</span>
    </div>
    <div style="margin-top:8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:#888;margin-bottom:6px;">Clusters</div>
  `;
  container.appendChild(typeLegend);

  Object.entries(counts).sort((a, b) => b[1] - a[1]).forEach(([cluster, count]) => {
    const color = colorOf(cluster);
    const item  = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.cluster = cluster;
    item.innerHTML = `
      <div class="legend-dot" style="background:${color};"></div>
      <span class="legend-label">${escHtml(cluster)}</span>
      <span class="legend-count">${count}</span>
    `;
    item.addEventListener('click', () => toggleClusterFilter(cluster, item));
    container.appendChild(item);
  });
}

function toggleClusterFilter(cluster, itemEl) {
  if (state.activeCluster === cluster) {
    state.activeCluster = null;
    document.querySelectorAll('.legend-item').forEach((el) => el.classList.remove('active'));
  } else {
    state.activeCluster = cluster;
    document.querySelectorAll('.legend-item').forEach((el) => el.classList.remove('active'));
    itemEl.classList.add('active');
    // Focus cluster nodes
    const clusterNodeIds = state.rawNodes.filter((n) => clusterOf(n.topic) === cluster).map((n) => n.id);
    if (clusterNodeIds.length > 0 && state.network) {
      state.network.fit({ nodes: clusterNodeIds, animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
    }
  }
  applyFilters();
}

// ========================================================================
// EXPORT PNG
// ========================================================================
function exportPng() {
  if (!state.network) return;
  const canvas = state.network.canvas.frame.canvas;
  const link   = document.createElement('a');
  link.download = `brain-graph-${Date.now()}.png`;
  link.href     = canvas.toDataURL('image/png');
  link.click();
}

// ========================================================================
// THEME TOGGLE
// ========================================================================
function toggleTheme() {
  const html  = document.documentElement;
  const isDark = html.getAttribute('data-theme') !== 'light';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');

  // Update icon
  const icon = document.getElementById('theme-icon');
  if (!isDark) {
    // switching to dark
    icon.innerHTML = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  } else {
    // switching to light
    icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }

  // Background is CSS-controlled — no vis.Network option needed.
  if (state.network) {
    // Trigger a redraw so node/edge colors update immediately.
    state.network.redraw();
  }
}

// ========================================================================
// PANEL COLLAPSE / TOGGLE
// ========================================================================
function initPanelCollapse() {
  document.querySelectorAll('.panel-header[data-target]').forEach((header) => {
    header.addEventListener('click', () => {
      const panel = header.closest('.panel');
      if (panel) panel.classList.toggle('collapsed');
    });
  });
}

// ========================================================================
// TOOLBAR BUTTON WIRING
// ========================================================================
function initToolbar() {
  document.getElementById('btn-fit').addEventListener('click', () => {
    state.network && state.network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  });

  document.getElementById('btn-path').addEventListener('click', () => {
    const panel = document.getElementById('panel-path');
    const btn   = document.getElementById('btn-path');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    btn.classList.toggle('active', !visible);
    clearPath();
  });

  document.getElementById('btn-filter').addEventListener('click', () => {
    const panel = document.getElementById('panel-filter');
    const btn   = document.getElementById('btn-filter');
    const visible = panel.style.display !== 'none';
    panel.style.display = visible ? 'none' : 'block';
    btn.classList.toggle('active', !visible);
  });

  document.getElementById('btn-export').addEventListener('click', exportPng);
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Zoom buttons
  document.getElementById('zoom-in').addEventListener('click', () => {
    if (!state.network) return;
    const scale = state.network.getScale();
    state.network.moveTo({ scale: scale * 1.3, animation: { duration: 250, easingFunction: 'linear' } });
  });
  document.getElementById('zoom-out').addEventListener('click', () => {
    if (!state.network) return;
    const scale = state.network.getScale();
    state.network.moveTo({ scale: scale / 1.3, animation: { duration: 250, easingFunction: 'linear' } });
  });
  document.getElementById('zoom-fit').addEventListener('click', () => {
    state.network && state.network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
  });

  // Info panel close
  document.getElementById('info-close').addEventListener('click', hideInfoPanel);

  // Search input
  let searchDebounce;
  document.getElementById('toolbar-search').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => applySearch(e.target.value), 180);
  });

  // Edge type chips
  document.querySelectorAll('.chip[data-edge-type]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const etype = chip.dataset.edgeType;
      if (state.activeEdgeTypes.has(etype)) {
        state.activeEdgeTypes.delete(etype);
        chip.classList.remove('active');
      } else {
        state.activeEdgeTypes.add(etype);
        chip.classList.add('active');
      }
      applyFilters();
    });
  });

  // Confidence range
  const confRange = document.getElementById('conf-range');
  const confVal   = document.getElementById('conf-val');
  confRange.addEventListener('input', () => {
    state.minConfidence = Number.parseFloat(confRange.value);
    confVal.textContent = confRange.value;
    applyFilters();
  });

  // Path finder button
  document.getElementById('path-find-btn').addEventListener('click', runPathFinder);
}

// ========================================================================
// KEYBOARD SHORTCUTS
// ========================================================================
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName.toLowerCase();
    const inInput = tag === 'input' || tag === 'textarea';

    if (e.key === 'Escape') {
      hideInfoPanel();
      clearPath();
      state.activeCluster = null;
      document.getElementById('toolbar-search').value = '';
      applySearch('');
      document.querySelectorAll('.legend-item').forEach((el) => el.classList.remove('active'));
      return;
    }

    if (!inInput) {
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        state.network && state.network.fit({ animation: { duration: 500, easingFunction: 'easeInOutQuad' } });
      }
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        document.getElementById('toolbar-search').focus();
      }
    }
  });
}

// ========================================================================
// RE-LAYOUT BUTTON (shown when precomputed positions are in use)
// ========================================================================

/**
 * Insert a "Re-run layout" button into the zoom-controls area.
 * Clicking it enables live vis-network physics on demand.
 */
function showRelayoutButton() {
  const zoomControls = document.getElementById('zoom-controls');
  if (!zoomControls || document.getElementById('btn-relayout')) return;

  const btn = document.createElement('button');
  btn.className = 'zoom-btn';
  btn.id = 'btn-relayout';
  btn.title = 'Re-run live physics layout';
  btn.style.cssText = 'font-size:9px;letter-spacing:.02em;width:auto;padding:0 6px;';
  btn.textContent = 'Live';
  btn.addEventListener('click', enableLivePhysics);
  zoomControls.appendChild(btn);
}

/**
 * Enable live vis-network physics so the user can experience the animated layout.
 * Disables itself again after stabilization.
 */
function enableLivePhysics() {
  if (!state.network) return;
  const btn = document.getElementById('btn-relayout');
  if (btn) btn.disabled = true;

  state.network.setOptions({
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -50,
        centralGravity: 0.005,
        springLength: 120,
        springConstant: 0.08,
        damping: 0.4,
        avoidOverlap: 0.5,
      },
      stabilization: { enabled: false },
    },
  });

  state.network.once('stabilizationIterationsDone', () => {
    state.network.setOptions({ physics: { enabled: false } });
    if (btn) btn.disabled = false;
  });
}

// ========================================================================
// MAIN INIT
// ========================================================================
async function main() {
  initPanelCollapse();
  initToolbar();
  initKeyboard();

  try {
    // Fetch full graph and slim layout in parallel — slim provides fast positions,
    // full graph provides tooltips, filters, path-finder, and info-panel data.
    const [graph, slim] = await Promise.all([loadGraph(), loadSlimLayout()]);

    state.rawNodes = graph.nodes || [];
    state.rawEdges = graph.edges || [];

    // Inject slim positions into raw nodes when available (avoids relying on
    // graph.json position fields which may be absent in older brains).
    if (slim) injectSlimPositions(state.rawNodes, slim);

    // Detect whether positions are precomputed in the graph data
    state.hasPrecomputedLayout =
      (slim?.hasPositions) ||
      state.rawNodes.some((n) => typeof n.x === 'number' && typeof n.y === 'number');

    // Build dynamic cluster color map from actual topics
    buildClusterColors(state.rawNodes);

    // Update stats
    document.getElementById('stat-nodes').textContent = state.rawNodes.length;
    document.getElementById('stat-edges').textContent = state.rawEdges.length;

    const visNodeArr = buildVisNodes(state.rawNodes);
    const visEdgeArr = buildVisEdges(state.rawEdges);

    const container = document.getElementById('graph-network');
    initNetwork(container, visNodeArr, visEdgeArr);

    buildLegend();

    // Hide loading overlay (when not using precomputed positions, physics may still be running)
    if (!state.hasPrecomputedLayout) {
      document.getElementById('loading-overlay').style.display = 'none';
    }

  } catch (err) {
    const overlay = document.getElementById('loading-overlay');
    overlay.innerHTML = `
      <div style="color:#ef9a9a;font-family:monospace;text-align:center;padding:24px;">
        <div style="font-size:16px;margin-bottom:8px;">Failed to load graph</div>
        <div style="font-size:12px;opacity:.7;">${escHtml(err.message)}</div>
        <div style="font-size:11px;opacity:.5;margin-top:12px;">Make sure the server is running: lazybrain serve</div>
      </div>
    `;
  }
}

// ========================================================================
// UTILITIES
// ========================================================================
function escHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
function escAttr(text) {
  return String(text ?? '').replace(/"/g, '&quot;');
}

// Start
main();
