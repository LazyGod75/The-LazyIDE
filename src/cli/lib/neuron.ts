/**
 * Build a valid LazyBrain neuron HTML from a capture event.
 * Mirrors event_to_html() in src-tauri/src/lib.rs exactly.
 */

export interface InsightPayload {
  kind: string;
  title: string;
  description: string;
  actionable: boolean;
  suggestion?: string;
}

export interface CaptureEvent {
  kind: 'episodic' | 'decision' | 'agent' | 'commit' | 'learning';
  title: string;
  text: string;
  tags?: string[];
  files?: string[];
  source?: string;
  topic?: string;
  space?: 'topical' | 'code';
  insights?: InsightPayload[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map(c => (/[\w-]/.test(c) ? c : '-'))
    .join('')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export function buildNeuronHtml(ev: CaptureEvent): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const date = now.slice(0, 10);

  const cerveauType = ev.kind === 'decision' ? 'decision' : ev.kind === 'commit' ? 'procedural' : ev.kind === 'learning' ? 'learning' : 'episodic';
  const id = slugify(`${ev.title}-${date}`);
  const source = ev.source ?? 'lazy-cli:capture';
  const tagsStr = (ev.tags ?? []).join(' ');

  const topicAttr = ev.topic ? `\n         data-cerveau-topic="${escapeHtml(ev.topic)}"` : '';
  const spaceAttr = ev.space === 'topical' || ev.space === 'code' ? `\n         data-cerveau-space="${ev.space}"` : '';

  const filesHtml =
    ev.files && ev.files.length > 0
      ? `  <ul>\n${ev.files.map(f => `    <li data-cerveau-fact data-cerveau-extracted-by="human"><code>${escapeHtml(f)}</code></li>`).join('\n')}\n  </ul>\n`
      : '';

  const insightsHtml = ev.insights && ev.insights.length > 0
    ? `  <section data-cerveau-learning>\n${ev.insights.map(ins => {
        const confidence = ins.kind === 'success_pattern' ? '0.9'
          : ins.kind === 'failure_pattern' ? '0.7'
          : ins.kind === 'brain_adaptation' ? '0.95'
          : ins.kind === 'test_insight' ? '0.8'
          : ins.kind === 'security_insight' ? '0.85'
          : ins.kind === 'performance_insight' ? '0.75'
          : '0.6';
        const actionableAttr = ins.actionable ? ' data-cerveau-actionable="true"' : '';
        const suggestionHtml = ins.suggestion
          ? `    <p data-cerveau-suggestion data-cerveau-extracted-by="agent">${escapeHtml(ins.suggestion)}</p>\n`
          : '';
        return `  <div data-cerveau-insight data-cerveau-insight-kind="${escapeHtml(ins.kind)}" data-cerveau-confidence="${confidence}"${actionableAttr}>\n    <p data-cerveau-fact data-cerveau-extracted-by="agent">${escapeHtml(ins.description)}</p>\n${suggestionHtml}  </div>`;
      }).join('\n')}\n  </section>\n`
    : '';

  return `<article id="${id}"
         data-cerveau-version="0.1.0"
         data-cerveau-created="${now}"
         data-cerveau-updated="${now}"
         data-cerveau-type="${cerveauType}"
         data-cerveau-source="${source}"
         data-cerveau-tier="working"
         data-cerveau-importance="0.6"
         data-cerveau-tags="${tagsStr}"${topicAttr}${spaceAttr}>

  <h2>${escapeHtml(ev.title)}</h2>

  <p data-cerveau-fact data-cerveau-confidence="1.0" data-cerveau-extracted-by="human">
    ${escapeHtml(ev.text)}
  </p>
${filesHtml}${insightsHtml}</article>
`;
}
