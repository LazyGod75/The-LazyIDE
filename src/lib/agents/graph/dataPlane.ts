/* graph/dataPlane.ts — Typed data flow between graph nodes.

   Implements GraphEdge.map (fromPath → toPath) and optional outputSchema
   validation on task/contest nodes. Pure helpers — no I/O.
*/

import type { GraphIR, GraphNode, GraphRun, StepContract } from './types.js';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface StructuredOutputResult {
  ok: boolean;
  value?: JsonValue;
  text: string;
  error?: string;
}

/** Read a dotted path from an object (`a.b.0.c`). */
export function getPath(obj: unknown, path: string): unknown {
  if (!path || path === '.' || path === '$') return obj;
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Set a dotted path on a plain object (mutates and returns root). */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  if (parts.length === 0) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(root, value as Record<string, unknown>);
    } else {
      root.value = value;
    }
    return root;
  }
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next == null || typeof next !== 'object' || Array.isArray(next)) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  return root;
}

/** Extract JSON object/array from agent text (fenced block or raw). */
export function extractJsonFromText(text: string): JsonValue | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  if (!candidate) return undefined;

  try {
    return JSON.parse(candidate) as JsonValue;
  } catch {
    // try first {...} or [...]
    const objStart = candidate.indexOf('{');
    const arrStart = candidate.indexOf('[');
    let start = -1;
    if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) start = objStart;
    else if (arrStart >= 0) start = arrStart;
    if (start < 0) return undefined;
    const slice = candidate.slice(start);
    try {
      return JSON.parse(slice) as JsonValue;
    } catch {
      // balanced scan
      const open = slice[0];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      for (let i = 0; i < slice.length; i++) {
        if (slice[i] === open) depth++;
        else if (slice[i] === close) {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(slice.slice(0, i + 1)) as JsonValue;
            } catch {
              return undefined;
            }
          }
        }
      }
      return undefined;
    }
  }
}

/**
 * Minimal JSON-Schema-ish check (type + required + properties only).
 * Enough for Format/output contracts without pulling a full validator.
 */
export function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): string | null {
  const type = schema.type as string | undefined;
  if (type === 'object') {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      return 'expected object';
    }
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (!(key in obj)) return `missing required field: ${key}`;
    }
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (props) {
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in obj && propSchema) {
          const err = validateAgainstSchema(obj[key], propSchema);
          if (err) return `${key}: ${err}`;
        }
      }
    }
    return null;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return 'expected array';
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateAgainstSchema(value[i], items);
        if (err) return `[${i}]: ${err}`;
      }
    }
    return null;
  }
  if (type === 'string' && typeof value !== 'string') return 'expected string';
  if (type === 'number' && typeof value !== 'number') return 'expected number';
  if (type === 'boolean' && typeof value !== 'boolean') return 'expected boolean';
  if (type === 'null' && value !== null) return 'expected null';
  return null;
}

export function parseStructuredOutput(
  text: string,
  contract?: StepContract,
): StructuredOutputResult {
  const schema = contract?.outputSchema;
  if (!schema) {
    const json = extractJsonFromText(text);
    return { ok: true, value: json ?? { text }, text };
  }
  const json = extractJsonFromText(text);
  if (json === undefined) {
    return { ok: false, text, error: 'output did not contain valid JSON for outputSchema' };
  }
  const err = validateAgainstSchema(json, schema);
  if (err) {
    return { ok: false, value: json, text, error: `outputSchema validation failed: ${err}` };
  }
  return { ok: true, value: json, text };
}

/** Build the input bag for a node from upstream node outputs + edge maps. */
export function buildNodeInput(
  ir: GraphIR,
  run: GraphRun,
  nodeId: string,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const incoming = ir.edges.filter((e) => e.to === nodeId && (e.kind === 'data' || e.map?.length));

  for (const edge of incoming) {
    const upstream = run.nodeOutputs?.[edge.from];
    if (upstream === undefined) continue;

    if (edge.map && edge.map.length > 0) {
      for (const m of edge.map) {
        const val = getPath(upstream, m.fromPath);
        if (val !== undefined) setPath(input, m.toPath, val);
      }
    } else if (edge.kind === 'data') {
      // default: nest under source node id
      input[edge.from] = upstream;
    }
  }

  // Also pull plain control predecessors' outputs under their ids when no explicit data edge
  if (incoming.length === 0) {
    const controlPreds = ir.edges.filter((e) => e.to === nodeId && e.kind === 'control');
    for (const edge of controlPreds) {
      const upstream = run.nodeOutputs?.[edge.from];
      if (upstream !== undefined) {
        input[edge.from] = upstream;
      }
    }
  }

  return input;
}

/** Header marking the start of the auto-appended "upstream graph inputs"
 *  block in a node's task text (see buildTaskForNode in runGraph.ts).
 *  Exported so missionScopeGuard.ts can strip this block — and everything
 *  after it — before scanning task text for a path: this block is
 *  machine-generated JSON, not part of the task's real instruction, and can
 *  legitimately contain unrelated absolute paths (e.g. a prior node's
 *  output). */
export const UPSTREAM_GRAPH_INPUTS_HEADER = '## Upstream graph inputs';

export function formatInputBlock(input: Record<string, unknown>): string {
  if (Object.keys(input).length === 0) return '';
  try {
    return `${UPSTREAM_GRAPH_INPUTS_HEADER}\n\`\`\`json\n${JSON.stringify(input, null, 2)}\n\`\`\``;
  } catch {
    return '';
  }
}

export function formatOutputSchemaHint(contract?: StepContract): string {
  const schema = contract?.outputSchema;
  if (!schema) return '';
  try {
    return `## Required output format\nRespond with a single JSON value matching this schema:\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``;
  } catch {
    return '';
  }
}

export function contractOf(node: GraphNode): StepContract | undefined {
  if (node.kind === 'task' || node.kind === 'contest') return node.contract;
  return undefined;
}
