/* Mock data for the Review / Changes space ÔÇö DEMO DATA ONLY.
   These entries are never shown unless the app is running in web/demo mode.
   All mock entries are labelled with isDemo: true so the UI can show a badge.
*/

// ÔöÇÔöÇ Judge / Verdict types (CONTRACT-D) ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
// These mirror the types that AGENTS-D will add to src/lib/mock/agents.ts.
// They are defined here so REVIEW-D can use them without editing agents.ts.

export type ReviewerRole = 'tester' | 'reviewer' | 'security' | 'judge';
export type ReviewerDecision = 'approve' | 'request_changes' | 'reject';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface ReviewerVerdict {
  role: ReviewerRole;
  verdict: ReviewerDecision;
  summary: string;
  score?: number;
}

export interface JudgeVerdict {
  score: number;
  passed: boolean;
  risk: RiskLevel;
  reviewers: ReviewerVerdict[];
  tests?: { passed: number; failed: number };
  createdAt: string;
}

// ÔöÇÔöÇ Change types ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ

export interface PendingChange {
  id: string;
  title: string;
  worktree: string;
  added: number;
  removed: number;
  author: 'agent' | 'user';
  status: 'review' | 'in_progress' | 'local';
  /** judgesApproved: backward-compat string ÔÇö derive from judgeVerdict when present. */
  judgesApproved?: string;
  /** Full structured judge verdict when available. */
  judgeVerdict?: JudgeVerdict;
  model?: string;
  /** True for every mock entry so the UI can render a visible demo badge. */
  isDemo?: boolean;
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk';
  content: string;
}

export interface DiffFile {
  filename: string;
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface ReviewDiff {
  changeId: string;
  files: DiffFile[];
}

export const PENDING_CHANGES: PendingChange[] = [
  {
    id: 'C1',
    title: 'Bug #342',
    worktree: 'wt/bug-342',
    added: 142,
    removed: 37,
    author: 'agent',
    status: 'review',
    judgesApproved: '2 juges (demo)',
    model: 'Opus 4.8',
    isDemo: true,
    judgeVerdict: {
      score: 87,
      passed: true,
      risk: 'medium',
      createdAt: '2026-06-20T10:31:00.000Z',
      tests: { passed: 24, failed: 1 },
      reviewers: [
        {
          role: 'tester',
          verdict: 'approve',
          summary: '24/25 tests passing ÔÇö one flaky assertion on timeout edge case.',
          score: 85,
        },
        {
          role: 'reviewer',
          verdict: 'approve',
          summary: 'Code structure clean, BaseHandler pattern applied consistently.',
          score: 90,
        },
        {
          role: 'security',
          verdict: 'request_changes',
          summary: 'Auth header check present but missing rate-limit guard on the validate path.',
          score: 78,
        },
        {
          role: 'judge',
          verdict: 'approve',
          summary: 'Overall quality meets bar. Security note logged as follow-up.',
          score: 87,
        },
      ],
    },
  },
  {
    id: 'C2',
    title: 'Refactor Auth',
    worktree: 'wt/auth-refactor',
    added: 68,
    removed: 21,
    author: 'agent',
    status: 'in_progress',
    model: 'Opus 4.8',
    isDemo: true,
  },
  {
    id: 'C3',
    title: 'Tes modifs locales',
    worktree: 'local',
    added: 14,
    removed: 3,
    author: 'user',
    status: 'local',
    isDemo: true,
  },
];

export const REVIEW_DIFFS: ReviewDiff[] = [
  {
    changeId: 'C1',
    files: [
      {
        filename: 'src/base-handler.ts',
        added: 98,
        removed: 24,
        lines: [
          { type: 'hunk',    content: '@@ -12,8 +12,52 @@ export class BaseHandler {' },
          { type: 'context', content: '  constructor(private readonly config: HandlerConfig) {}' },
          { type: 'context', content: '' },
          { type: 'remove',  content: '-  handle(req: any) {' },
          { type: 'remove',  content: '-    return null;' },
          { type: 'remove',  content: '-  }' },
          { type: 'add',     content: '+  handle(req: Request): Response {' },
          { type: 'add',     content: '+    this.validate(req);' },
          { type: 'add',     content: '+    return this.process(req);' },
          { type: 'add',     content: '+  }' },
          { type: 'add',     content: '+' },
          { type: 'add',     content: '+  private validate(req: Request): void {' },
          { type: 'add',     content: '+    if (!req.headers.get("Authorization")) {' },
          { type: 'add',     content: '+      throw new UnauthorizedError("Missing auth header");' },
          { type: 'add',     content: '+    }' },
          { type: 'add',     content: '+  }' },
          { type: 'context', content: '}' },
        ],
      },
      {
        filename: 'src/auth.ts',
        added: 44,
        removed: 13,
        lines: [
          { type: 'hunk',    content: '@@ -1,6 +1,18 @@ import { BaseHandler } from "./base-handler";' },
          { type: 'remove',  content: '-import { handleAuth } from "./legacy";' },
          { type: 'add',     content: '+import { OAuthConfig } from "./oauth-config";' },
          { type: 'context', content: '' },
          { type: 'remove',  content: '-export function authMiddleware(req) {' },
          { type: 'remove',  content: '-  return handleAuth(req);' },
          { type: 'remove',  content: '-}' },
          { type: 'add',     content: '+export class AuthHandler extends BaseHandler {' },
          { type: 'add',     content: '+  constructor(config: OAuthConfig) {' },
          { type: 'add',     content: '+    super(config);' },
          { type: 'add',     content: '+  }' },
          { type: 'add',     content: '+' },
          { type: 'add',     content: '+  protected process(req: Request): Response {' },
          { type: 'add',     content: '+    return this.pkceFlow(req);' },
          { type: 'add',     content: '+  }' },
          { type: 'add',     content: '+}' },
        ],
      },
    ],
  },
  {
    changeId: 'C2',
    files: [
      {
        filename: 'src/base-handler.ts',
        added: 48,
        removed: 12,
        lines: [
          { type: 'hunk',    content: '@@ -8,6 +8,22 @@ export abstract class BaseHandler {' },
          { type: 'context', content: '  abstract process(req: Request): Response;' },
          { type: 'remove',  content: '-  // TODO: add validation' },
          { type: 'add',     content: '+  validate(req: Request): asserts req is Request {' },
          { type: 'add',     content: '+    if (!req) throw new Error("Invalid request");' },
          { type: 'add',     content: '+  }' },
          { type: 'context', content: '}' },
        ],
      },
      {
        filename: 'src/auth.ts',
        added: 20,
        removed: 9,
        lines: [
          { type: 'hunk',    content: '@@ -20,10 +20,19 @@ export class AuthHandler extends BaseHandler {' },
          { type: 'context', content: '  protected process(req: Request): Response {' },
          { type: 'remove',  content: '-    // wip' },
          { type: 'add',     content: '+    this.validate(req);' },
          { type: 'add',     content: '+    return this.pkceFlow(req);' },
          { type: 'context', content: '  }' },
        ],
      },
    ],
  },
  {
    changeId: 'C3',
    files: [
      {
        filename: 'src/auth.ts',
        added: 14,
        removed: 3,
        lines: [
          { type: 'hunk',    content: '@@ -42,7 +42,18 @@ export class AuthHandler extends BaseHandler {' },
          { type: 'context', content: '  private async pkceFlow(req: Request): Promise<Response> {' },
          { type: 'remove',  content: '-    return new Response("ok");' },
          { type: 'add',     content: '+    const code = await this.exchangeCode(req);' },
          { type: 'add',     content: '+    const token = await this.fetchToken(code);' },
          { type: 'add',     content: '+    return new Response(JSON.stringify({ token }), {' },
          { type: 'add',     content: '+      headers: { "Content-Type": "application/json" },' },
          { type: 'add',     content: '+    });' },
          { type: 'context', content: '  }' },
        ],
      },
    ],
  },
];
