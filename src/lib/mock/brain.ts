/* Brain mock data — typed dataset for the Brain space (3D graph + wiki).
   37 nodes, 55 links, rich wiki payloads for hero nodes.
   Cluster palette: Auth #9B7CFF | Paiement #4FC3F7 | Tests #66E27A | Infra #FFC76B | UI #FF7BB0
*/

// ── Types ─────────────────────────────────────────────────────────

export type NodeType = 'decision' | 'bug' | 'file' | 'concept' | 'module';
export type ClusterId = 'Auth' | 'Paiement' | 'Tests' | 'Infra' | 'UI';
export type LinkType =
  | 'suit' | 'uses' | 'refines' | 'replaces' | 'cites' | 'follows'
  | 'touches' | 'implements' | 'depends' | 'contains' | 'improves'
  | 'measures' | 'contributes' | 'helps' | 'configures' | 'tests'
  | 'documents' | 'guides' | 'exposes';

export interface BrainNode {
  id: number;
  name: string;
  type: NodeType;
  cluster: ClusterId;
  val: number; // importance 1–10
}

export interface BrainLink {
  source: number;
  target: number;
  type: LinkType;
}

export interface WikiLink {
  label: string;
  target: string;
}

export interface WikiPayload {
  title: string;
  type: NodeType;
  status: 'active' | 'archived';
  meta: string;
  tags: string[];
  body: string;
  links: WikiLink[];
  files: string[];
  validity: string;
  cluster: ClusterId;
  /** Ids of notes this note contradicts (from /_api/note-meta conflictWith).
   *  Non-empty → BrainWiki renders a contradiction warning. */
  conflictWith?: string[];
  /** Saliency kind from the engine (e.g. 'contradiction'). */
  saliencyKind?: string | null;
  /** Display author from note HTML (data-cerveau-author) — not on BrainNoteMeta. */
  author?: string;
  /** YYYY-MM-DD (or already-formatted) creation date for NoteMeta. */
  when?: string;
}

// ── Cluster config ────────────────────────────────────────────────

export const CLUSTER_COLOR: Record<ClusterId, string> = {
  Auth:     '#9B7CFF',
  Paiement: '#4FC3F7',
  Tests:    '#66E27A',
  Infra:    '#FFC76B',
  UI:       '#FF7BB0',
};

export const CLUSTER_COLOR_HEX: Record<ClusterId, number> = {
  Auth:     0x9B7CFF,
  Paiement: 0x4FC3F7,
  Tests:    0x66E27A,
  Infra:    0xFFC76B,
  UI:       0xFF7BB0,
};

export const CLUSTER_STATS: Record<ClusterId, string> = {
  Auth:     '10 neurones dans ce cluster',
  Paiement: '9 neurones dans ce cluster',
  Tests:    '7 neurones dans ce cluster',
  Infra:    '6 neurones dans ce cluster',
  UI:       '5 neurones dans ce cluster',
};

export const CLUSTER_CENTER: Record<ClusterId, { x: number; y: number; z: number }> = {
  Auth:     { x: -260, y:  90, z:  60 },
  Paiement: { x:  220, y: 120, z: -100 },
  Tests:    { x:   30, y: -200, z:  160 },
  Infra:    { x: -130, y: -130, z: -210 },
  UI:       { x:  260, y:  -50, z:  140 },
};

// ── Hero wiki payloads ─────────────────────────────────────────────

export const WIKI_DATA: Record<string, WikiPayload> = {
  'Migration OAuth2 PKCE': {
    title: 'Migration JWT → OAuth2 PKCE',
    type: 'decision',
    status: 'active',
    meta: 'Auth · 14/03/2026',
    tags: ['#auth', '#security', '#oauth'],
    body: "Abandon du JWT custom au profit d'OAuth2 PKCE après l'audit sécurité Q2 (faille sur le refresh). Handlers unifiés via BaseHandler suite au bug #342.",
    links: [
      { label: 'raffine →',   target: 'Stratégie Auth' },
      { label: 'cite →',      target: 'Audit sécurité Q2' },
      { label: 'remplace →',  target: 'JWT custom' },
      { label: 'suit →',      target: 'Bug #342 handler dupliqué' },
    ],
    files: ['auth.ts', 'base-handler.ts'],
    validity: 'Valide depuis le 14/03/2026 · toujours active',
    cluster: 'Auth',
  },
  'Bug #342 handler dupliqué': {
    title: 'Bug #342 — Handler dupliqué',
    type: 'bug',
    status: 'archived',
    meta: 'Auth · 10/03/2026',
    tags: ['#bug', '#auth', '#handler'],
    body: "Duplication des handlers d'authentification causant des doubles appels OAuth. Corrigé via BaseHandler centralisé.",
    links: [
      { label: 'précède →',  target: 'Migration OAuth2 PKCE' },
      { label: 'touche →',   target: 'base-handler.ts' },
    ],
    files: ['base-handler.ts', 'auth-middleware.ts'],
    validity: 'Résolu le 14/03/2026 · archivé',
    cluster: 'Auth',
  },
  'BaseHandler': {
    title: 'BaseHandler',
    type: 'concept',
    status: 'active',
    meta: 'Auth · 14/03/2026',
    tags: ['#architecture', '#handler', '#pattern'],
    body: "Classe de base unifiée pour tous les handlers d'authentification. Élimine la duplication, expose onRequest / onResponse standardisés.",
    links: [
      { label: 'implémenté dans →', target: 'base-handler.ts' },
      { label: 'utilisé par →',      target: 'auth.ts' },
      { label: 'résout →',           target: 'Bug #342 handler dupliqué' },
    ],
    files: ['base-handler.ts'],
    validity: 'Introduit le 14/03/2026 · toujours actif',
    cluster: 'Auth',
  },
  'auth.ts': {
    title: 'auth.ts',
    type: 'file',
    status: 'active',
    meta: 'Auth · 14/03/2026',
    tags: ['#auth', '#file', '#typescript'],
    body: 'Point d\'entrée du module auth. Orchestre PKCE flow, gère tokens, sessions, refresh. Dépend de BaseHandler.',
    links: [
      { label: 'dépend de →', target: 'BaseHandler' },
      { label: 'dépend de →', target: 'auth-middleware.ts' },
    ],
    files: ['auth.ts'],
    validity: 'Modifié le 14/03/2026',
    cluster: 'Auth',
  },
  'Postgres vs SQLite': {
    title: 'Postgres vs SQLite — choix infra BDD',
    type: 'decision',
    status: 'active',
    meta: 'Infra · 05/02/2026',
    tags: ['#infra', '#database', '#postgres'],
    body: 'Choix de PostgreSQL (Supabase) face à SQLite embarqué. Raisons : scalabilité, RLS natif, Edge Functions, support JSON avancé.',
    links: [
      { label: 'dépend de →',   target: 'Supabase setup' },
      { label: 'influence →',    target: 'rate-limiting' },
      { label: 'remplace →',     target: 'SQLite prod' },
    ],
    files: ['db.config.ts', 'migrations/'],
    validity: 'Validé le 05/02/2026 · toujours actif',
    cluster: 'Infra',
  },
  'Module Paiement': {
    title: 'Module Paiement',
    type: 'module',
    status: 'active',
    meta: 'Paiement · 01/04/2026',
    tags: ['#stripe', '#payments', '#module'],
    body: 'Module gérant l\'intégration Stripe : checkout, webhooks, abonnements, idempotency.',
    links: [
      { label: 'contient →',   target: 'Stripe webhooks idempotency' },
      { label: 'dépend de →',  target: 'stripe-sdk' },
      { label: 'expose →',     target: 'API /pay' },
    ],
    files: ['payment/index.ts', 'payment/webhooks.ts', 'payment/stripe.ts'],
    validity: 'Actif depuis le 01/04/2026',
    cluster: 'Paiement',
  },
  'Stripe webhooks idempotency': {
    title: 'Stripe Webhooks — Idempotency Key',
    type: 'decision',
    status: 'active',
    meta: 'Paiement · 12/04/2026',
    tags: ['#stripe', '#idempotency', '#webhook'],
    body: 'Tous les webhooks Stripe stockent leur event ID en BDD avant traitement. Prévient les doubles exécutions sur retry.',
    links: [
      { label: 'fait partie de →', target: 'Module Paiement' },
      { label: 'utilise →',        target: 'Postgres vs SQLite' },
    ],
    files: ['payment/webhooks.ts', 'payment/idempotency.ts'],
    validity: 'Appliqué depuis le 12/04/2026',
    cluster: 'Paiement',
  },
  'Migration Vitest': {
    title: 'Migration Jest → Vitest',
    type: 'decision',
    status: 'active',
    meta: 'Tests · 20/02/2026',
    tags: ['#tests', '#vitest', '#tooling'],
    body: 'Abandon de Jest au profit de Vitest pour compatibilité ESM native, vitesse (×4) et intégration Vite.',
    links: [
      { label: 'remplace →',   target: 'Jest config' },
      { label: 'améliore →',   target: 'CI pipeline' },
    ],
    files: ['vitest.config.ts', 'package.json'],
    validity: 'Migré le 20/02/2026 · toujours actif',
    cluster: 'Tests',
  },
  'rate-limiting': {
    title: 'Rate Limiting — API Gateway',
    type: 'decision',
    status: 'active',
    meta: 'Infra · 15/03/2026',
    tags: ['#infra', '#security', '#rate-limit'],
    body: 'Sliding window rate limiting sur toutes les routes API (100 req/min/IP). Implémenté via Redis + middleware Express. Retourne 429 avec Retry-After.',
    links: [
      { label: 'dépend de →',         target: 'Postgres vs SQLite' },
      { label: 'protège →',            target: 'Auth endpoints' },
      { label: 'implémenté dans →',    target: 'middleware/rate-limit.ts' },
    ],
    files: ['middleware/rate-limit.ts', 'config/limits.ts'],
    validity: 'Actif depuis le 15/03/2026',
    cluster: 'Infra',
  },
};

// ── Nodes ─────────────────────────────────────────────────────────

export const NODES: BrainNode[] = [
  // Auth cluster (10 nodes)
  { id: 1,  name: 'Migration OAuth2 PKCE',      type: 'decision', cluster: 'Auth',     val: 10 },
  { id: 2,  name: 'Bug #342 handler dupliqué',  type: 'bug',      cluster: 'Auth',     val: 7  },
  { id: 3,  name: 'auth.ts',                    type: 'file',     cluster: 'Auth',     val: 5  },
  { id: 4,  name: 'BaseHandler',                type: 'concept',  cluster: 'Auth',     val: 8  },
  { id: 5,  name: 'Stratégie Auth',             type: 'concept',  cluster: 'Auth',     val: 6  },
  { id: 6,  name: 'base-handler.ts',            type: 'file',     cluster: 'Auth',     val: 4  },
  { id: 7,  name: 'auth-middleware.ts',         type: 'file',     cluster: 'Auth',     val: 3  },
  { id: 8,  name: 'JWT custom',                 type: 'concept',  cluster: 'Auth',     val: 4  },
  { id: 9,  name: 'Audit sécurité Q2',          type: 'concept',  cluster: 'Auth',     val: 5  },
  { id: 10, name: 'session.ts',                 type: 'file',     cluster: 'Auth',     val: 3  },
  // Paiement cluster (9 nodes)
  { id: 11, name: 'Module Paiement',            type: 'module',   cluster: 'Paiement', val: 8  },
  { id: 12, name: 'Stripe webhooks idempotency',type: 'decision', cluster: 'Paiement', val: 7  },
  { id: 13, name: 'payment/index.ts',           type: 'file',     cluster: 'Paiement', val: 4  },
  { id: 14, name: 'payment/webhooks.ts',        type: 'file',     cluster: 'Paiement', val: 4  },
  { id: 15, name: 'Checkout flow',              type: 'concept',  cluster: 'Paiement', val: 5  },
  { id: 16, name: 'Abonnements SaaS',           type: 'concept',  cluster: 'Paiement', val: 5  },
  { id: 17, name: 'payment/stripe.ts',          type: 'file',     cluster: 'Paiement', val: 3  },
  { id: 18, name: 'idempotency.ts',             type: 'file',     cluster: 'Paiement', val: 3  },
  { id: 19, name: 'Stripe SDK config',          type: 'concept',  cluster: 'Paiement', val: 4  },
  // Tests cluster (7 nodes)
  { id: 20, name: 'Migration Vitest',           type: 'decision', cluster: 'Tests',    val: 6  },
  { id: 21, name: 'vitest.config.ts',           type: 'file',     cluster: 'Tests',    val: 3  },
  { id: 22, name: 'Couverture 80%',             type: 'concept',  cluster: 'Tests',    val: 5  },
  { id: 23, name: 'CI pipeline',                type: 'concept',  cluster: 'Tests',    val: 5  },
  { id: 24, name: 'auth.test.ts',               type: 'file',     cluster: 'Tests',    val: 3  },
  { id: 25, name: 'payment.test.ts',            type: 'file',     cluster: 'Tests',    val: 3  },
  { id: 26, name: 'Mocking Stripe',             type: 'concept',  cluster: 'Tests',    val: 4  },
  // Infra cluster (6 nodes)
  { id: 27, name: 'Postgres vs SQLite',         type: 'decision', cluster: 'Infra',    val: 9  },
  { id: 28, name: 'rate-limiting',              type: 'decision', cluster: 'Infra',    val: 6  },
  { id: 29, name: 'Supabase setup',             type: 'concept',  cluster: 'Infra',    val: 6  },
  { id: 30, name: 'db.config.ts',               type: 'file',     cluster: 'Infra',    val: 3  },
  { id: 31, name: 'middleware/rate-limit.ts',   type: 'file',     cluster: 'Infra',    val: 3  },
  { id: 32, name: 'Docker Compose',             type: 'concept',  cluster: 'Infra',    val: 4  },
  // UI cluster (5 nodes)
  { id: 33, name: 'Design System',             type: 'concept',  cluster: 'UI',       val: 7  },
  { id: 34, name: 'components/Button.tsx',      type: 'file',     cluster: 'UI',       val: 3  },
  { id: 35, name: 'Theme dark/light',           type: 'decision', cluster: 'UI',       val: 5  },
  { id: 36, name: 'tokens.css',                 type: 'file',     cluster: 'UI',       val: 3  },
  { id: 37, name: 'Accessibilité WCAG',         type: 'concept',  cluster: 'UI',       val: 4  },
];

// ── Links ─────────────────────────────────────────────────────────

export const LINKS: BrainLink[] = [
  // Auth internal
  { source: 1,  target: 2,  type: 'suit' },
  { source: 1,  target: 4,  type: 'uses' },
  { source: 1,  target: 5,  type: 'refines' },
  { source: 1,  target: 8,  type: 'replaces' },
  { source: 1,  target: 9,  type: 'cites' },
  { source: 2,  target: 4,  type: 'follows' },
  { source: 2,  target: 6,  type: 'touches' },
  { source: 4,  target: 3,  type: 'implements' },
  { source: 4,  target: 6,  type: 'implements' },
  { source: 3,  target: 7,  type: 'depends' },
  { source: 5,  target: 9,  type: 'cites' },
  { source: 1,  target: 10, type: 'touches' },
  // Paiement internal
  { source: 11, target: 12, type: 'contains' },
  { source: 11, target: 13, type: 'contains' },
  { source: 11, target: 14, type: 'contains' },
  { source: 11, target: 15, type: 'contains' },
  { source: 11, target: 16, type: 'contains' },
  { source: 12, target: 14, type: 'implements' },
  { source: 12, target: 18, type: 'implements' },
  { source: 15, target: 17, type: 'implements' },
  { source: 13, target: 17, type: 'depends' },
  { source: 19, target: 17, type: 'configures' },
  { source: 16, target: 18, type: 'depends' },
  // Tests internal
  { source: 20, target: 21, type: 'implements' },
  { source: 20, target: 23, type: 'improves' },
  { source: 22, target: 23, type: 'measures' },
  { source: 24, target: 22, type: 'contributes' },
  { source: 25, target: 22, type: 'contributes' },
  { source: 26, target: 25, type: 'helps' },
  // Infra internal
  { source: 27, target: 29, type: 'depends' },
  { source: 27, target: 30, type: 'implements' },
  { source: 28, target: 31, type: 'implements' },
  { source: 29, target: 30, type: 'configures' },
  { source: 32, target: 29, type: 'depends' },
  // UI internal
  { source: 33, target: 34, type: 'contains' },
  { source: 33, target: 36, type: 'implements' },
  { source: 35, target: 36, type: 'implements' },
  { source: 37, target: 34, type: 'guides' },
  // Cross-cluster
  { source: 1,  target: 28, type: 'depends' },
  { source: 12, target: 27, type: 'uses' },
  { source: 24, target: 1,  type: 'tests' },
  { source: 25, target: 12, type: 'tests' },
  { source: 28, target: 27, type: 'depends' },
  { source: 11, target: 27, type: 'uses' },
  { source: 33, target: 3,  type: 'guides' },
  { source: 37, target: 36, type: 'guides' },
  { source: 23, target: 20, type: 'improves' },
  { source: 26, target: 11, type: 'helps' },
  { source: 29, target: 27, type: 'configures' },
  { source: 32, target: 27, type: 'depends' },
  { source: 20, target: 22, type: 'improves' },
  { source: 35, target: 33, type: 'implements' },
  { source: 19, target: 11, type: 'configures' },
];
