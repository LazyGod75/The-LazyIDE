import { esc } from '../helpers.js';

export interface GraphEmbedInput {
  scope: 'brain' | 'project';
  project?: string;
  stats: {
    nodes: number;
    edges: number;
    clusters: number;
    hubs: number;
  };
  nodes?: Array<{
    id: string;
    title: string;
    type: string;
    topicPath: string;
    connections: number;
  }>;
  clusters: Array<{
    id: string;
    label: string;
    nodeCount: number;
    hubs: Array<{ id: string; title: string }>;
    connectedClusters: string[];
  }>;
  hubs: Array<{
    id: string;
    title: string;
    topic: string;
    inbound: number;
    outbound: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: string;
  }>;
  crossProjectEdges?: Array<{
    source: string;
    target: string;
    targetProject: string;
    type: string;
  }>;
  layers?: Array<{
    id: string;
    name: string;
    description: string;
    nodeCount: number;
  }>;
  tour?: Array<{
    order: number;
    title: string;
    noteId: string;
    description: string;
  }>;
}

const EDGE_LIMIT = 200;

function toSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function renderClusterTable(clusters: GraphEmbedInput['clusters']): string {
  const rows = clusters
    .map((c) => {
      const slug = toSlug(c.label);
      const hubTitles = c.hubs.map((h) => esc(h.title)).join(', ');
      const connected = c.connectedClusters.map(esc).join(', ');
      return [
        '      <tr>',
        `        <td><a href="#/topic-overview-${esc(slug)}">${esc(c.label)}</a></td>`,
        `        <td>${c.nodeCount}</td>`,
        `        <td>${hubTitles || '—'}</td>`,
        `        <td>${connected || '—'}</td>`,
        '      </tr>',
      ].join('\n');
    })
    .join('\n');

  return [
    `  <table class="wikitable">`,
    '    <caption>Cluster Map</caption>',
    '    <thead><tr><th>Cluster</th><th>Notes</th><th>Key Nodes</th><th>Connected to</th></tr></thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
  ].join('\n');
}

function renderHubList(hubs: GraphEmbedInput['hubs'], tag: 'ol' | 'ul'): string {
  const items = hubs
    .map((h) => {
      const isBrain = tag === 'ol';
      const inner = isBrain
        ? `<a href="#/${esc(h.id)}">${esc(h.title)}</a> (${esc(h.topic)}) — ${h.inbound}↓ ${h.outbound}↑`
        : `<a href="#/${esc(h.id)}">${esc(h.title)}</a> — ${h.inbound + h.outbound} connections`;
      return `      <li data-node="${esc(h.id)}">${inner}</li>`;
    })
    .join('\n');

  return [`    <${tag}>`, items, `    </${tag}>`].join('\n');
}

function renderAdjacencyList(edges: GraphEmbedInput['edges'], hubIds: ReadonlySet<string>): string {
  const truncated = edges.length > EDGE_LIMIT;
  const visible = truncated ? edges.slice(0, EDGE_LIMIT) : edges;

  const lines = visible.map((e) => {
    const prefix = hubIds.has(e.source) ? '[HUB ' : '[';
    return `${prefix}${e.source}] --${e.type}--> [${e.target}]`;
  });

  if (truncated) {
    lines.push(`...and ${edges.length - EDGE_LIMIT} more`);
  }

  return lines.join('\n');
}

function renderLayersTable(layers: NonNullable<GraphEmbedInput['layers']>): string {
  const rows = layers
    .filter((l) => l.nodeCount > 0)
    .map((l) =>
      [
        '      <tr>',
        `        <td>${esc(l.name)}</td>`,
        `        <td>${l.nodeCount}</td>`,
        `        <td>${esc(l.description)}</td>`,
        '      </tr>',
      ].join('\n'),
    )
    .join('\n');

  return [
    `  <table class="wikitable">`,
    '    <caption>Knowledge Layers</caption>',
    '    <thead><tr><th>Layer</th><th>Notes</th><th>Description</th></tr></thead>',
    '    <tbody>',
    rows,
    '    </tbody>',
    '  </table>',
  ].join('\n');
}

function renderTour(tour: NonNullable<GraphEmbedInput['tour']>, headingTag: 'h3' | 'h4'): string {
  if (tour.length === 0) return '';

  const sorted = [...tour].sort((a, b) => a.order - b.order);
  const items = sorted
    .map(
      (t) =>
        `      <li><a href="#/${esc(t.noteId)}">${esc(t.title)}</a> — ${esc(t.description)}</li>`,
    )
    .join('\n');

  return [
    `  <section data-section="graph-tour">`,
    `    <${headingTag}>Guided Tour</${headingTag}>`,
    '    <ol>',
    items,
    '    </ol>',
    '  </section>',
  ].join('\n');
}

function renderBrainGraph(input: GraphEmbedInput): string {
  const { stats, clusters, hubs, edges, layers, tour } = input;
  const hubIds = new Set(hubs.map((h) => h.id));

  const clusterTable = renderClusterTable(clusters);
  const layersTable = layers && layers.length > 0 ? renderLayersTable(layers) : '';
  const hubList = renderHubList(hubs, 'ol');
  const tourSection = tour && tour.length > 0 ? renderTour(tour, 'h3') : '';
  const adjacency = renderAdjacencyList(edges, hubIds);

  return [
    `<section data-section="graph" data-graph-scope="brain">`,
    '  <h2>Knowledge Graph</h2>',
    `  <p><data value="${stats.nodes}">${stats.nodes}</data> notes connected by <data value="${stats.edges}">${stats.edges}</data> relationships across <data value="${stats.clusters}">${stats.clusters}</data> clusters.</p>`,
    clusterTable,
    layersTable,
    `  <section data-section="graph-hubs">`,
    '    <h3>Hub Nodes</h3>',
    hubList,
    '  </section>',
    tourSection,
    '  <details>',
    `    <summary>Edge map (${stats.edges} edges)</summary>`,
    `    <pre data-graph-format="adjacency">`,
    adjacency,
    '    </pre>',
    '  </details>',
    '</section>',
  ]
    .filter((p) => p.length > 0)
    .join('\n');
}

function renderProjectGraph(input: GraphEmbedInput): string {
  const { stats, hubs, edges, crossProjectEdges = [], project, tour } = input;
  const projectAttr = project ? ` data-graph-project="${esc(project)}"` : '';
  const hubIds = new Set(hubs.map((h) => h.id));

  const hubList = renderHubList(hubs, 'ul');
  const tourSection = tour && tour.length > 0 ? renderTour(tour, 'h4') : '';
  const adjacency = renderAdjacencyList(edges, hubIds);

  const crossSection =
    crossProjectEdges.length === 0
      ? ''
      : [
          '  <details>',
          `    <summary>Cross-project links (${crossProjectEdges.length})</summary>`,
          `    <pre data-graph-format="adjacency">`,
          crossProjectEdges
            .map((e) => `[${e.source}] --${e.type}--> [${e.targetProject}:${e.target}]`)
            .join('\n'),
          '    </pre>',
          '  </details>',
        ].join('\n');

  return [
    `<section data-section="graph" data-graph-scope="project"${projectAttr}>`,
    '  <h3>Project Graph</h3>',
    `  <p><data value="${stats.nodes}">${stats.nodes}</data> notes, <data value="${stats.edges}">${stats.edges}</data> edges, <data value="${crossProjectEdges.length}">${crossProjectEdges.length}</data> cross-project links.</p>`,
    `  <section data-section="graph-hubs">`,
    '    <h4>Key Nodes</h4>',
    hubList,
    '  </section>',
    tourSection,
    '  <details>',
    `    <summary>Internal edges (${stats.edges})</summary>`,
    `    <pre data-graph-format="adjacency">`,
    adjacency,
    '    </pre>',
    '  </details>',
    crossSection,
    '</section>',
  ]
    .filter((p) => p.length > 0)
    .join('\n');
}

export function composeGraphSection(input: GraphEmbedInput): string {
  return input.scope === 'brain' ? renderBrainGraph(input) : renderProjectGraph(input);
}
