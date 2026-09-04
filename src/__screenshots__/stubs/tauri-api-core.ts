/* tauri-api-core.ts — stub for @tauri-apps/api/core in the screenshot harness.
   invoke('teams_search') returns demo brain search results. */

import type { TeamBrainSearchResult } from '../../lib/teams/types';

const DEMO_RESULTS: TeamBrainSearchResult[] = [
  {
    id: 'note-arch-001',
    title: 'Architecture microservices — décisions 2026',
    excerpt:
      'Migration vers une architecture en microservices validée lors de la session Q1. Pattern CQRS adopté pour les services critiques.',
    author: 'alice@acme.com',
    agent: 'architect',
    team: null,
    dept: 'engineering',
    scope: 'dept:engineering',
  },
  {
    id: 'note-auth-002',
    title: 'Auth OAuth2 PKCE — implémentation',
    excerpt:
      'Le flux PKCE remplace le code exchange direct. Refresh tokens rotatifs activés côté Supabase. Tests E2E couverts.',
    author: 'bob@acme.com',
    agent: 'code-reviewer',
    team: null,
    dept: null,
    scope: 'org',
  },
  {
    id: 'note-ux-003',
    title: 'Design System v2 — token reference',
    excerpt:
      'Tokens CSS définis dans design-system.css. Violet accent #7C5CFF. Background principal #0E0E12.',
    author: 'clara@acme.com',
    agent: 'tdd-guide',
    team: null,
    dept: 'design',
    scope: 'dept:design',
  },
];

export async function invoke<T>(cmd: string, _args?: unknown): Promise<T> {
  if (cmd === 'teams_search') {
    // Return JSON string as the real Rust command does
    return JSON.stringify(DEMO_RESULTS) as unknown as T;
  }
  throw new Error(`Unhandled Tauri command in stub: ${cmd}`);
}
