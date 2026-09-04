/* acpAgent.ts — P7.5: ACP (Agent Communication Protocol) external agent slot.

   Allows plugging in external agents via the ACP protocol. An ACP agent
   receives task descriptions and returns results over a standardized
   JSON-RPC-like interface, enabling third-party agent integration without
   modifying the core runtime.

   This module provides the adapter that wraps an ACP endpoint as a
   GraphExecutorDeps-compatible launch function.
*/

/** ACP agent descriptor. */
export interface AcpAgent {
  id: string;
  name: string;
  endpoint: string;
  /** Auth token for the ACP endpoint. */
  token?: string;
  /** Supported capabilities. */
  capabilities?: string[];
}

/** ACP request shape. */
export interface AcpRequest {
  jsonrpc: '2.0';
  id: string;
  method: 'agent.run';
  params: {
    task: string;
    context?: Record<string, unknown>;
    timeout?: number;
  };
}

/** ACP response shape. */
export interface AcpResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    status: 'done' | 'failed';
    output: string;
    costUsd?: number;
    durationMs?: number;
  };
  error?: {
    code: number;
    message: string;
  };
}

/** Launch a task via an ACP agent endpoint. */
export async function launchViaAcp(
  agent: AcpAgent,
  task: string,
  context?: Record<string, unknown>,
): Promise<AcpResponse> {
  const requestId = `acp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const request: AcpRequest = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'agent.run',
    params: {
      task,
      context,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (agent.token) {
    headers.Authorization = `Bearer ${agent.token}`;
  }

  const resp = await fetch(agent.endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    throw new Error(`ACP agent ${agent.name} returned HTTP ${resp.status}`);
  }

  return await resp.json() as AcpResponse;
}

/** Registry of available ACP agents. */
export class AcpAgentRegistry {
  private agents = new Map<string, AcpAgent>();

  register(agent: AcpAgent): void {
    this.agents.set(agent.id, agent);
  }

  unregister(id: string): void {
    this.agents.delete(id);
  }

  get(id: string): AcpAgent | undefined {
    return this.agents.get(id);
  }

  list(): AcpAgent[] {
    return Array.from(this.agents.values());
  }
}
