import { enrichFactWithSemantics, esc } from './helpers.js';
import type { InToolTrace } from './types.js';

/**
 * Render tool-run traces (Bash/pytest/grep output) for L1 section_tool_trace retrieval.
 * Returns empty string when no traces are detected and no tool is specified.
 */
export function renderToolTrace(input: InToolTrace): string {
  const traces = input.facts.filter((f) =>
    /\b(Bash:|pytest|Output:|FAILED|grep|docker build|npm install|EXPLAIN)\b/i.test(f.text),
  );
  if (traces.length === 0 && !input.tool) return '';
  const body =
    traces.length > 0
      ? traces.map((f) => `    <p>${enrichFactWithSemantics(esc(f.text))}</p>`).join('\n')
      : `    <p>${esc(input.tool ?? 'tool')} run recorded.</p>`;
  return [`  <section data-section="tool_trace">`, body, '  </section>'].join('\n');
}
