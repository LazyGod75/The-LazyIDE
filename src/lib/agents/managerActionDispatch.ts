/* managerActionDispatch — look up a manager-action handler by type.

   executeManagerAction used to be one 2.7k-line switch (~80 cases). ESLint
   complexity counts every `case` against that single function. A map lookup
   keeps the dispatcher under the ratchet; each handler is its own function.
*/

export const MANAGER_ACTION_EXECUTOR_NOOPS = new Set<string>([
  'info',
  'list_agents',
  'list_missions',
  'canvas_overview',
  'query_mission',
  'get_agent_output',
  'brain_query',
  'brain_query_css',
  'brain_neighbours',
  'web_search',
  'web_fetch',
  'scan_project',
  'briefing_query',
  'decision_lookup',
  'propose_mission_charter',
]);

export function isManagerActionExecutorNoop(type: string): boolean {
  return MANAGER_ACTION_EXECUTOR_NOOPS.has(type);
}

export async function runManagerActionHandler<A extends { type: string }, R>(
  action: A,
  handlers: Partial<Record<string, (action: A) => R | Promise<R>>>,
): Promise<R | void> {
  if (isManagerActionExecutorNoop(action.type)) return;
  const handler = handlers[action.type];
  if (!handler) {
    throw new Error(
      `Unknown manager action type: ${typeof action.type === 'string' ? action.type : 'unknown'}`,
    );
  }
  return handler(action);
}
