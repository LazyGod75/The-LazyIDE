import { describe, it, expect, beforeEach } from 'vitest';
import { listAgents, saveAgent, deleteAgent } from '../lib/agents/agentsStorage';
import { createNewAgent } from '../lib/agents/agentDef';

// agentsStorage uses isTauri() which returns false in jsdom (no __TAURI_INTERNALS__),
// so all operations go through the in-memory _mockStore path.
// Note: _mockStore is module-level, so we need to clean up between tests.

beforeEach(async () => {
  // Clear the store by deleting all agents
  const agents = await listAgents();
  for (const stored of agents) {
    await deleteAgent(stored.scope, stored.agent.id);
  }
});

describe('agentsStorage (web/mock path)', () => {
  it('listAgents returns empty array when nothing is saved', async () => {
    const agents = await listAgents();
    expect(agents).toEqual([]);
  });

  it('saveAgent adds a new agent to the store', async () => {
    const agent = createNewAgent({ name: 'test-agent', displayName: 'Test' });
    await saveAgent('user', agent);

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agent.id).toBe(agent.id);
    expect(agents[0].scope).toBe('user');
  });

  it('saveAgent upserts (updates) an existing agent by id', async () => {
    const agent = createNewAgent({ name: 'my-agent', displayName: 'My Agent' });
    await saveAgent('project', agent);

    const updated = { ...agent, displayName: 'Updated Agent' };
    await saveAgent('project', updated);

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0].agent.displayName).toBe('Updated Agent');
  });

  it('saveAgent supports user and project scopes independently', async () => {
    const a1 = createNewAgent({ name: 'user-agent', displayName: 'User Agent' });
    const a2 = createNewAgent({ name: 'proj-agent', displayName: 'Project Agent' });

    await saveAgent('user', a1);
    await saveAgent('project', a2);

    const agents = await listAgents();
    expect(agents).toHaveLength(2);
  });

  it('deleteAgent removes an agent by id and scope', async () => {
    const agent = createNewAgent({ name: 'to-delete', displayName: 'Delete Me' });
    await saveAgent('user', agent);
    await deleteAgent('user', agent.id);

    const agents = await listAgents();
    expect(agents).toHaveLength(0);
  });

  it('deleteAgent with wrong scope does not remove agent', async () => {
    const agent = createNewAgent({ name: 'scope-test', displayName: 'Scope Test' });
    await saveAgent('user', agent);
    // Try to delete with 'project' scope — should not find it
    await deleteAgent('project', agent.id);

    const agents = await listAgents();
    expect(agents).toHaveLength(1);
  });

  it('deleteAgent is idempotent for unknown id', async () => {
    // Should not throw
    await expect(deleteAgent('user', 'nonexistent-id')).resolves.toBeUndefined();
  });

  it('listAgents returns a copy (not the internal array)', async () => {
    const agent = createNewAgent({ name: 'copy-test', displayName: 'Copy Test' });
    await saveAgent('user', agent);

    const list1 = await listAgents();
    const list2 = await listAgents();
    expect(list1).not.toBe(list2); // different array references
    expect(list1).toEqual(list2);   // same contents
  });
});
