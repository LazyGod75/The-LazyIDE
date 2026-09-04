/* yamlWorkflowImport.ts — P8.3: Deterministic YAML workflow import.

   Imports a YAML workflow definition and converts it into a GraphIR.
   This enables sharing agent workflows as human-readable YAML files,
   similar to GitHub Actions or GitLab CI definitions.

   YAML schema:
     name: My Workflow
     defaults:
       max_parallel: 3
       brain: recall
     steps:
       - id: analyze
         task: "Analyze the codebase"
         model: haiku
       - id: implement
         task: "Implement the fix"
         depends_on: [analyze]
       - id: test
         task: "Run tests"
         depends_on: [implement]
         on_fail: retry
*/

import type { GraphIR, GraphNode, GraphEdge, TaskNode, GraphDefaults, BrainPolicy } from './types.js';
import { defaultGraphDefaults, defaultBrainPolicy, defaultStepContract } from './types.js';

export interface YamlWorkflowStep {
  id: string;
  task: string;
  model?: string;
  agent?: string;
  depends_on?: string[];
  on_fail?: 'retry' | 'skip' | 'abort';
  max_attempts?: number;
  brain?: 'recall' | 'none' | 'contest';
}

export interface YamlWorkflow {
  name: string;
  description?: string;
  defaults?: {
    max_parallel?: number;
    brain?: 'recall' | 'none' | 'contest';
    model?: string;
  };
  steps: YamlWorkflowStep[];
}

/** Parse a YAML workflow string into a GraphIR. */
export function parseYamlWorkflow(yaml: string): GraphIR {
  const workflow = simpleYamlParse(yaml);
  return workflowToGraphIR(workflow);
}

/** Convert a parsed YamlWorkflow into a GraphIR. */
export function workflowToGraphIR(workflow: YamlWorkflow): GraphIR {
  const defaults: GraphDefaults = {
    ...defaultGraphDefaults(),
    maxParallelNodes: workflow.defaults?.max_parallel ?? 0,
  };

  const brainPolicy: BrainPolicy = {
    ...defaultBrainPolicy(),
    recall: (workflow.defaults?.brain ?? 'recall') !== 'none',
  };

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  for (const step of workflow.steps) {
    const node: TaskNode = {
      id: step.id,
      kind: 'task',
      label: step.id,
      description: step.task,
      brain: { ...brainPolicy, recall: (step.brain ?? 'recall') !== 'none' },
      contract: {
        ...defaultStepContract(),
      },
    };
    nodes.push(node);

    // Create edges from depends_on
    if (step.depends_on) {
      for (const dep of step.depends_on) {
        edges.push({
          id: `edge-${dep}-${step.id}`,
          from: dep,
          to: step.id,
          kind: 'control',
        });
      }
    }
  }

  return {
    id: `workflow-${workflow.name.toLowerCase().replace(/\s+/g, '-')}`,
    version: 1,
    name: workflow.name,
    objective: workflow.description ?? workflow.name,
    projectId: '',
    defaults,
    nodes,
    edges,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: 'yaml',
  };
}

/** Minimal YAML parser — handles the subset of YAML used by workflows.
 *  For production use, consider js-yaml. This parser handles:
 *  - Key: value pairs
 *  - Lists (- item)
 *  - Nested objects (indentation-based)
 *  - String values (quoted or unquoted)
 */
function simpleYamlParse(yaml: string): YamlWorkflow {
  const lines = yaml.split('\n');
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];

  for (const line of lines) {
    if (line.trim().startsWith('#') || line.trim() === '') continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    // Pop stack to current indent level
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith('- ')) {
      // List item
      const value = trimmed.slice(2).trim();
      const key = getLastKey(parent);
      if (key) {
        const list = parent[key];
        if (Array.isArray(list)) {
          if (value.includes(':') && !value.startsWith('"')) {
            // It's an object in a list
            const obj: Record<string, unknown> = {};
            parseInlineObject(value, obj);
            list.push(obj);
            stack.push({ indent: indent + 2, obj });
          } else {
            list.push(stripQuotes(value));
          }
        }
      }
    } else if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (value === '') {
        // Could be a list or nested object
        parent[key] = [];
        stack.push({ indent, obj: parent });
      } else {
        parent[key] = stripQuotes(value);
      }
    }
  }

  return root as unknown as YamlWorkflow;
}

function getLastKey(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  return keys[keys.length - 1] ?? null;
}

function parseInlineObject(value: string, obj: Record<string, unknown>): void {
  // Handle "id: analyze" style inline
  const parts = value.split(':');
  if (parts.length >= 2) {
    obj[parts[0].trim()] = stripQuotes(parts.slice(1).join(':').trim());
  }
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Export a GraphIR back to YAML workflow format. */
export function exportYamlWorkflow(ir: GraphIR): string {
  const lines: string[] = [
    `name: ${ir.name ?? ir.id}`,
  ];

  if (ir.defaults.maxParallelNodes) {
    lines.push('defaults:');
    lines.push(`  max_parallel: ${ir.defaults.maxParallelNodes}`);
  }

  lines.push('steps:');

  for (const node of ir.nodes) {
    if (node.kind === 'task') {
      lines.push(`  - id: ${node.id}`);
      lines.push(`    task: "${node.description}"`);
      const deps = ir.edges
        .filter((e) => e.to === node.id && e.kind === 'control')
        .map((e) => e.from);
      if (deps.length > 0) {
        lines.push(`    depends_on: [${deps.join(', ')}]`);
      }
    }
  }

  return lines.join('\n');
}
