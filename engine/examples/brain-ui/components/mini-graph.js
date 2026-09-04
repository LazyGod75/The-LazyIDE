// examples/brain-ui/components/mini-graph.js
// Renders a focused "local graph" panel for a single note and its neighbors.
// Uses vis-network when window.vis is available, falls back to a plain SVG layout.
// Lazy: builds only when the panel becomes visible (IntersectionObserver).

import { escapeHtml } from './shared.js';
import { fetchNeighbors } from '../lib/api-client.js';

/**
 * Create and append a local-graph panel inside container.
 * The panel header is always rendered immediately; the graph itself is built
 * lazily once the element scrolls into view.
 *
 * @param {Element} container  - parent element to append the panel into
 * @param {object}  note       - current note object { id, title, type, ... }
 * @returns {void}
 */
export function mountMiniGraph(container, note) {
  const panel = document.createElement('section');
  panel.className = 'mini-graph-panel';
  panel.setAttribute('aria-label', 'Local knowledge graph');
  panel.dataset.noteId = note.id;

  panel.innerHTML = `
    <div class="mini-graph-header">
      <h3 class="mini-graph-title">Local graph</h3>
      <button
        type="button"
        class="mini-graph-toggle"
        aria-expanded="true"
        aria-controls="mini-graph-canvas-wrap"
      >Collapse</button>
    </div>
    <div class="mini-graph-body" id="mini-graph-canvas-wrap">
      <div class="mini-graph-loading" aria-live="polite">Loading graph&hellip;</div>
    </div>
  `;

  container.appendChild(panel);

  // Wire collapse toggle via event delegation on the panel
  panel.addEventListener('click', (e) => {
    const btn = e.target.closest('.mini-graph-toggle');
    if (!btn) return;
    const body = panel.querySelector('.mini-graph-body');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    btn.textContent = expanded ? 'Expand' : 'Collapse';
    body.hidden = expanded;
  });

  // Build graph lazily when the panel enters the viewport
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          obs.disconnect();
          buildGraph(panel, note);
        }
      }
    },
    { rootMargin: '200px' }
  );
  observer.observe(panel);
}

/**
 * Fetch neighbors and render the graph inside panel.
 * @param {Element} panel
 * @param {object}  note
 */
async function buildGraph(panel, note) {
  const body = panel.querySelector('.mini-graph-body');
  if (!body) return;

  let data;
  try {
    data = await fetchNeighbors(note.id);
  } catch (err) {
    body.innerHTML = `<p class="mini-graph-error">${escapeHtml(err.message)}</p>`;
    return;
  }

  const inbound = Array.isArray(data.inbound) ? data.inbound : [];
  const outbound = Array.isArray(data.outbound) ? data.outbound : [];

  if (inbound.length === 0 && outbound.length === 0) {
    body.innerHTML = `<p class="mini-graph-empty">No connections found for this note.</p>`;
    return;
  }

  if (typeof window.vis !== 'undefined') {
    renderWithVis(body, note, inbound, outbound);
  } else {
    renderWithSvg(body, note, inbound, outbound);
  }
}

/* ─── vis-network renderer ─────────────────────────────────────────────── */

/**
 * Build a vis-network graph in body.
 * @param {Element} body
 * @param {object}  center  - current note
 * @param {Array}   inbound
 * @param {Array}   outbound
 */
function renderWithVis(body, center, inbound, outbound) {
  const wrap = document.createElement('div');
  wrap.className = 'mini-graph-vis';
  body.innerHTML = '';
  body.appendChild(wrap);

  const { nodesArr, edgesArr } = buildGraphData(center, inbound, outbound);

  const nodes = new window.vis.DataSet(nodesArr);
  const edges = new window.vis.DataSet(edgesArr);

  const options = {
    nodes: {
      shape: 'dot',
      size: 12,
      font: { size: 11, color: '#444' },
      borderWidth: 1,
      color: {
        border: '#b0c4de',
        background: '#dce8f8',
        highlight: { border: '#1a73e8', background: '#aecef7' },
      },
    },
    edges: {
      arrows: { to: { enabled: true, scaleFactor: 0.5 } },
      color: { color: '#aaa', highlight: '#1a73e8' },
      width: 1,
      smooth: { type: 'curvedCW', roundness: 0.2 },
    },
    layout: { improvedLayout: true },
    physics: {
      stabilization: { iterations: 80 },
      barnesHut: { gravitationalConstant: -2000, springLength: 120 },
    },
    interaction: { tooltipDelay: 200, navigationButtons: false, keyboard: false },
  };

  // Mark center node distinctly
  nodes.update({ id: center.id, color: { border: '#1a73e8', background: '#1a73e8' }, font: { color: '#fff' } });

  const network = new window.vis.Network(wrap, { nodes, edges }, options);

  // Navigate on node click
  network.on('click', (params) => {
    if (params.nodes.length === 0) return;
    const nodeId = params.nodes[0];
    if (nodeId !== center.id) {
      location.hash = `#/wiki/${encodeURIComponent(nodeId)}`;
    }
  });

  // Change cursor on hover
  network.on('hoverNode', () => { wrap.style.cursor = 'pointer'; });
  network.on('blurNode', () => { wrap.style.cursor = 'default'; });
}

/* ─── SVG fallback renderer ─────────────────────────────────────────────── */

/**
 * Build a simple radial SVG graph in body.
 * @param {Element} body
 * @param {object}  center
 * @param {Array}   inbound
 * @param {Array}   outbound
 */
function renderWithSvg(body, center, inbound, outbound) {
  const { nodesArr, edgesArr } = buildGraphData(center, inbound, outbound);

  const W = 360;
  const H = 260;
  const cx = W / 2;
  const cy = H / 2;
  const radius = 100;

  // Assign positions: center at (cx, cy), neighbors in a circle
  const neighbors = nodesArr.filter((n) => n.id !== center.id);
  const positions = new Map();
  positions.set(center.id, { x: cx, y: cy });

  neighbors.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / Math.max(neighbors.length, 1);
    positions.set(n.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  // Build SVG
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', H);
  svg.setAttribute('aria-label', 'Local knowledge graph');
  svg.classList.add('mini-graph-svg');

  // Defs — arrowhead marker
  const defs = document.createElementNS(svgNS, 'defs');
  defs.innerHTML = `
    <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 Z" fill="#aaa"/>
    </marker>`;
  svg.appendChild(defs);

  // Edges
  for (const edge of edgesArr) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const line = document.createElementNS(svgNS, 'line');
    line.setAttribute('x1', from.x);
    line.setAttribute('y1', from.y);
    line.setAttribute('x2', to.x);
    line.setAttribute('y2', to.y);
    line.setAttribute('stroke', '#ccc');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('marker-end', 'url(#arrowhead)');
    svg.appendChild(line);
  }

  // Nodes
  for (const node of nodesArr) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const isCenter = node.id === center.id;

    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('role', 'link');
    g.setAttribute('aria-label', node.label);
    g.style.cursor = isCenter ? 'default' : 'pointer';
    g.dataset.nodeId = node.id;

    const circle = document.createElementNS(svgNS, 'circle');
    circle.setAttribute('cx', pos.x);
    circle.setAttribute('cy', pos.y);
    circle.setAttribute('r', isCenter ? 14 : 9);
    circle.setAttribute('fill', isCenter ? '#1a73e8' : '#dce8f8');
    circle.setAttribute('stroke', isCenter ? '#1560c0' : '#b0c4de');
    circle.setAttribute('stroke-width', '1.5');
    g.appendChild(circle);

    const text = document.createElementNS(svgNS, 'text');
    text.setAttribute('x', pos.x);
    text.setAttribute('y', pos.y + (isCenter ? 26 : 20));
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', isCenter ? '10' : '9');
    text.setAttribute('fill', isCenter ? '#1a73e8' : '#555');
    text.textContent = truncate(node.label, 14);
    g.appendChild(text);

    svg.appendChild(g);
  }

  body.innerHTML = '';
  body.appendChild(svg);

  // Navigation via event delegation on the SVG
  svg.addEventListener('click', (e) => {
    const g = e.target.closest('g[data-node-id]');
    if (!g) return;
    const nodeId = g.dataset.nodeId;
    if (nodeId && nodeId !== center.id) {
      location.hash = `#/wiki/${encodeURIComponent(nodeId)}`;
    }
  });
}

/* ─── Shared helpers ────────────────────────────────────────────────────── */

/**
 * Build a deduplicated nodes + edges arrays from inbound/outbound neighbor data.
 * @param {object} center
 * @param {Array}  inbound
 * @param {Array}  outbound
 * @returns {{ nodesArr: Array, edgesArr: Array }}
 */
function buildGraphData(center, inbound, outbound) {
  const nodeMap = new Map();
  const edgesArr = [];

  // Add center
  nodeMap.set(center.id, { id: center.id, label: truncate(center.title || center.id, 20) });

  // Add inbound neighbors (they → center)
  for (const n of inbound) {
    const id = n.id || n.from;
    if (!id) continue;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, label: truncate(n.title || id, 18) });
    }
    edgesArr.push({ from: id, to: center.id, id: `${id}->${center.id}` });
  }

  // Add outbound neighbors (center → them)
  for (const n of outbound) {
    const id = n.id || n.to;
    if (!id) continue;
    if (!nodeMap.has(id)) {
      nodeMap.set(id, { id, label: truncate(n.title || id, 18) });
    }
    edgesArr.push({ from: center.id, to: id, id: `${center.id}->${id}` });
  }

  return { nodesArr: Array.from(nodeMap.values()), edgesArr };
}

/**
 * Truncate a label to maxLen chars.
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '…' : str;
}
