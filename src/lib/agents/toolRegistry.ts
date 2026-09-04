/* toolRegistry — central tool definitions with ACI-optimized descriptions.

   Inspired by SWE-agent's Agent-Computer Interface (NeurIPS 2024) and
   Trace-Free+ (2025) tool-description patterns. Each tool carries:
     - name:           the ReAct ACTION name the model emits
     - description:    ACI-optimized — includes scope, constraints, output
                       semantics, and cross-tool dependencies (the 5
                       Trace-Free+ patterns)
     - schema:         argument contract (JSON shape)
     - category:       grouping for permission/policy decisions
     - feedbackHint:   optional SWE-agent-style feedback formatting hint

   The registry is the single source of truth: managedAgentPolicy.ts
   generates the system prompt's tool list from it, managedToolPermissions
   maps tool names to permission patterns, and toolProfiles.ts overlays
   brain-learned addenda per-project.

   One-directional dependency: nothing in managedAgent.ts/policy/permissions
   imports back from here except through the typed exports below.
*/

export type ToolCategory =
  | 'navigation'
  | 'edit'
  | 'exec'
  | 'git'
  | 'web'
  | 'brain'
  | 'orchestration'
  | 'transform'
  | 'mcp'
  | 'browser'
  | 'cloud';

export interface ToolDef {
  name: string;
  category: ToolCategory;
  /** ACI-optimized description — scope, constraints, output, dependencies. */
  description: string;
  /** Argument schema in shorthand JSON-signature form for the system prompt. */
  schema: string;
  /** Whether this tool is blocked in plan (read-only) mode. */
  blockedInPlan: boolean;
  /** SWE-agent feedback hint — how the observation should be formatted. */
  feedbackHint?: string;
}

// ── Tool definitions ────────────────────────────────────────────────

const NAVIGATION_TOOLS: ToolDef[] = [
  {
    name: 'read_file',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Read a file and return a windowed view (100 lines by default, max 200). ' +
      'Output includes line numbers, total line count, and "N lines remaining" footer. ' +
      'Files are capped at 512KB — larger files return a truncated prefix with a "NOTE: file truncated" marker. ' +
      'Use start_line/end_line to scroll. ALWAYS read a file before editing it. ' +
      'Do NOT use read_file blindly without first locating the path via read_dir, glob, find_file, or search_code.',
    schema: '{"path": "relative/path", "start_line": 1, "end_line": 100}',
    feedbackHint: 'Prefix with "--- lines X-Y of Z ---", suffix "--- N lines remaining ---" when more exist.',
  },
  {
    name: 'read_dir',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'List immediate children of a directory. Returns compact "d/f name" listing. ' +
      'Use to orient yourself in the project structure before searching for specific files.',
    schema: '{"path": "relative/path/to/dir"}',
  },
  {
    name: 'find_file',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Search for files by name pattern across the ENTIRE repository (not just one directory). ' +
      'Returns up to 50 matching file paths. Use glob-style patterns: "**/*.ts", "**/auth*". ' +
      'Faster than read_dir + glob for locating files by name. ' +
      'Do NOT use for content search — use search_code instead.',
    schema: '{"pattern": "**/*.ts", "path": "optional/base/dir"}',
    feedbackHint: 'List one file path per line, prefix with count: "Files matching (N):".',
  },
  {
    name: 'search_code',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Search file CONTENTS across the entire repository using ripgrep. ' +
      'Returns a COMPACT list: file path + line number per match (no surrounding context — ' +
      'use read_file to see context after locating the match). ' +
      'Max 50 files returned. Use regex patterns. ' +
      'Prefer this over grep_file (which searches a single file) when you need repo-wide search. ' +
      'Do NOT use for finding files by name — use find_file instead.',
    schema: '{"pattern": "regex_pattern", "path": "optional/base/dir", "file_glob": "optional/*.ts"}',
    feedbackHint: 'Compact: "path:line: matched_text", one per line. "No matches" when empty.',
  },
  {
    name: 'search_symbols',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Search for symbol definitions (functions, classes, types, interfaces) across the repository. ' +
      'Uses tree-sitter or LSP. Returns symbol name + file + line. ' +
      'Use to locate "where is class X defined?" before reading or editing. ' +
      'Do NOT use for finding references — use find_references instead.',
    schema: '{"query": "function_name_or_class", "file_glob": "optional/*.ts"}',
    feedbackHint: 'Compact: "symbol_name at path:line", one per line.',
  },
  {
    name: 'goto_definition',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Jump to the definition of a symbol at a specific location. Uses LSP. ' +
      'Returns file path + line + column. Requires the language server to be running. ' +
      'Use after search_symbols to navigate to the exact definition.',
    schema: '{"path": "relative/file.ts", "line": 10, "column": 5}',
    feedbackHint: 'Returns "path:line:col" or "No definition found".',
  },
  {
    name: 'find_references',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Find all references to a symbol at a specific location. Uses LSP. ' +
      'Returns a compact list of file + line per reference. ' +
      'Use to understand impact before editing a function or class.',
    schema: '{"path": "relative/file.ts", "line": 10, "column": 5}',
    feedbackHint: 'Compact: "path:line", one per line. "No references found" when empty.',
  },
  {
    name: 'get_diagnostics',
    category: 'navigation',
    blockedInPlan: false,
    description:
      'Get LSP diagnostics (errors, warnings) for a file or the whole project. ' +
      'Returns severity + message + line. Use after editing to check for type errors. ' +
      'When path is empty, returns project-wide diagnostics (may be slower). ' +
      'Do NOT use run_command with tsc/lint for this — get_diagnostics is faster and more precise.',
    schema: '{"path": "optional/relative/file.ts"}',
    feedbackHint: 'Compact: "severity path:line message", one per line. "No diagnostics" when clean.',
  },
];

const EDIT_TOOLS: ToolDef[] = [
  {
    name: 'edit_file',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Replace an exact string in a file. Uses NO ARGS/JSON — see the "FILE EDITS" section of your instructions ' +
      'for the SEARCH/REPLACE block format (FILE: <path> then <<<<<<< SEARCH / ======= / >>>>>>> REPLACE). ' +
      'old_string is matched exactly first, then via indentation-normalized and blank-line-stripped fallbacks — ' +
      'ALWAYS read the file first to get real text, but a near-exact match still applies. ' +
      'Before writing, the tool runs a syntax check — if the edit would break syntax, it is REJECTED and the file is left unchanged. ' +
      'For multiple changes in one file, use multi_edit instead of multiple edit_file calls. ' +
      'Do NOT use write_file for targeted changes — write_file overwrites the entire file.',
    schema: 'ACTION: edit_file\\nFILE: relative/file.ts\\n<<<<<<< SEARCH\\nexact text\\n=======\\nreplacement\\n>>>>>>> REPLACE  (no ARGS/JSON)',
    feedbackHint: 'Return diff summary + match strategy, or "ERROR: ... REJECTED" on syntax break / no match.',
  },
  {
    name: 'multi_edit',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Apply multiple edits to a single file atomically (all-or-nothing). Uses NO ARGS/JSON — see the "FILE EDITS" ' +
      'section of your instructions: one FILE: <path> line followed by multiple SEARCH/REPLACE blocks, applied in order. ' +
      'If ANY block fails to match (after the exact/indent-normalized/blank-stripped fallback cascade), NO edits are applied. ' +
      'The final result is syntax-checked before writing — a syntax-breaking combination is REJECTED and the file is left unchanged. ' +
      'More efficient than multiple edit_file calls — saves agent turns. ' +
      'ALWAYS read the file first. Use for refactoring multiple sections of the same file.',
    schema: 'ACTION: multi_edit\\nFILE: relative/file.ts\\n<<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE\\n<<<<<<< SEARCH\\n...\\n=======\\n...\\n>>>>>>> REPLACE  (no ARGS/JSON, repeat blocks as needed)',
    feedbackHint: 'Return count of applied edits + diff summary.',
  },
  {
    name: 'write_file',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Create a new file or completely rewrite an existing one. Uses NO ARGS/JSON — see the "FILE EDITS" section of ' +
      'your instructions: FILE: <path> followed by one fenced code block with the full content. ' +
      'Use ONLY for new files or when rewriting >50% of the content. ' +
      'For targeted changes, use edit_file or multi_edit instead. ' +
      'Before writing, the tool runs a syntax check — if the content would break syntax, it is REJECTED and nothing is written. ' +
      'CRITICAL: You MUST call write_file to create files. Never claim you created a file without calling this tool.',
    schema: 'ACTION: write_file\\nFILE: relative/file.ts\\n```\\nfull file content\\n```  (no ARGS/JSON)',
    feedbackHint: 'Return "Wrote N bytes" or "ERROR: ... REJECTED" on syntax break.',
  },
  {
    name: 'undo_edit',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Undo the last edit_file/multi_edit/write_file operation on a specific file. ' +
      'Restores the previous content. Use when an edit introduced a regression and you need to revert quickly. ' +
      'Only one level of undo is available per file per mission.',
    schema: '{"path": "relative/file.ts"}',
    feedbackHint: 'Return "Reverted" or "Nothing to undo".',
  },
  {
    name: 'rename_file',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Rename or move a file. Both old_path and new_path must be within the project root. ' +
      'The parent directory of new_path must exist. Use for refactoring file names or locations.',
    schema: '{"old_path": "relative/old.ts", "new_path": "relative/new.ts"}',
  },
  {
    name: 'delete_file',
    category: 'edit',
    blockedInPlan: true,
    description:
      'Delete a file or directory (recursively). Silently succeeds if the path does not exist. ' +
      'Use with caution — deletion is permanent within the mission worktree. ' +
      'Do NOT use delete_file to "clean up" without being certain the file is not needed.',
    schema: '{"path": "relative/file.ts"}',
  },
];

const EXEC_TOOLS: ToolDef[] = [
  {
    name: 'run_command',
    category: 'exec',
    blockedInPlan: true,
    description:
      'Execute a shell command in the project worktree. Returns stdout + stderr + exit code. ' +
      'Output is truncated to 2000 chars. Timeout default 30s (set timeout_ms for longer). ' +
      'When the command produces no output, the observation says "Command ran successfully, no output." ' +
      'Use for lint, build, git operations, or any shell command. ' +
      'Do NOT use run_command for tests — use run_tests instead (it auto-detects the framework). ' +
      'Do NOT use run_command for linting — use run_lint instead (parsed, compact output).',
    schema: '{"command": "npm run build", "timeout_ms": 30000}',
    feedbackHint: 'Prefix with "[exit N]", truncate at 2000 chars. "Command ran successfully, no output." when empty.',
  },
  {
    name: 'run_tests',
    category: 'exec',
    blockedInPlan: true,
    description:
      'Run the project test suite. Auto-detects the framework (vitest, jest, pytest, cargo test, go test). ' +
      'Returns pass/fail counts + failure details. ' +
      'Optionally filter by file or test name pattern for faster runs. ' +
      'Use after writing/editing files to verify correctness. ' +
      'When a test is flaky (brain may warn you), retry before investigating.',
    schema: '{"file": "optional/test-file.ts", "pattern": "optional/test name pattern"}',
    feedbackHint: 'Return "Tests: N passed, M failed" + first 5 failure messages.',
  },
  {
    name: 'run_lint',
    category: 'exec',
    blockedInPlan: true,
    description:
      'Run the project linter (auto-detects eslint, biome, clippy, etc.). ' +
      'Returns parsed, compact output: severity + file + message per finding. ' +
      'Faster and more structured than run_command for linting. ' +
      'Use after editing to catch style/type issues before they become build errors.',
    schema: '{"file": "optional/file.ts"}',
    feedbackHint: 'Compact: "severity path:line message", one per line. "No lint issues" when clean.',
  },
  {
    name: 'run_build',
    category: 'exec',
    blockedInPlan: true,
    description:
      'Run the project build (auto-detects npm run build, cargo build, make, etc.). ' +
      'Returns success/failure + error messages. ' +
      'Use to verify the project compiles after significant changes. ' +
      'Do NOT use run_command for builds — run_build parses errors and returns them compactly.',
    schema: '{}',
    feedbackHint: 'Return "Build OK" or "Build FAILED" + first 10 errors.',
  },
];

const GIT_TOOLS: ToolDef[] = [
  {
    name: 'git_status',
    category: 'git',
    blockedInPlan: false,
    description:
      'Show working tree status (modified, added, deleted, untracked files). ' +
      'Returns compact porcelain output. Use to see what changed before committing or reviewing.',
    schema: '{}',
    feedbackHint: 'Compact: "M path", "A path", "?? path", one per line.',
  },
  {
    name: 'git_diff',
    category: 'git',
    blockedInPlan: false,
    description:
      'Show unified diff of working tree or a specific file. ' +
      'Use to review changes before FINAL or before committing. ' +
      'When path is empty, returns the full working-tree diff.',
    schema: '{"path": "optional/relative/file.ts"}',
    feedbackHint: 'Unified diff, truncated at 2000 chars.',
  },
  {
    name: 'git_log',
    category: 'git',
    blockedInPlan: false,
    description:
      'Show recent commit history (last 10 commits by default). ' +
      'Returns compact: hash + message per line. ' +
      'Use to understand recent project history before making changes.',
    schema: '{"count": 10}',
    feedbackHint: 'Compact: "hash message", one per line.',
  },
  {
    name: 'git_commit',
    category: 'git',
    blockedInPlan: true,
    description:
      'Stage specific files and commit with a message. ' +
      'Use after verifying changes with git_status + git_diff + run_tests. ' +
      'The message should be concise and describe what changed and why.',
    schema: '{"paths": ["relative/file1.ts", "relative/file2.ts"], "message": "feat: add auth check"}',
  },
  {
    name: 'review_diff',
    category: 'git',
    blockedInPlan: false,
    description:
      'Review all changes made by the agent in this mission so far. ' +
      'Returns a unified diff of all edits/writes since the mission started. ' +
      'Use BEFORE emitting FINAL to verify your work is correct and complete. ' +
      'This is your last chance to catch mistakes before the human reviews.',
    schema: '{}',
    feedbackHint: 'Unified diff, truncated at 3000 chars.',
  },
  {
    name: 'git_create_pr',
    category: 'git',
    blockedInPlan: true,
    description:
      'Create a GitHub Pull Request from the current branch using the gh CLI. ' +
      'Requires gh to be authenticated (gh auth login). ' +
      'Pushes the current branch first, then creates the PR. ' +
      'title: PR title (concise, descriptive). body: PR description with context and test plan. ' +
      'base: optional base branch (defaults to repo default). draft: optional, create as draft PR. ' +
      'Use AFTER git_commit to publish your work for review. ' +
      'Returns the PR URL on success.',
    schema: '{"title": "feat: add auth check", "body": "## Changes\n- Added auth middleware\n\n## Test plan\n- npm test", "base": "main", "draft": false}',
    feedbackHint: 'Return the PR URL on success, or "ERROR: ..." on failure.',
  },
];

const WEB_TOOLS: ToolDef[] = [
  {
    name: 'web_search',
    category: 'web',
    blockedInPlan: false,
    description:
      'Search the web via DuckDuckGo for up-to-date information. Returns structured results with title, URL, and snippet for each hit (up to 8 by default, max 20). ' +
      'Use when the brain has no relevant knowledge and you need external docs, API references, or current solutions. ' +
      'After finding relevant results, use web_fetch to read the full page content. ' +
      'Do NOT use web_search for project-specific questions — use brain_query or search_code instead.',
    schema: '{"query": "how to configure JWT in Express 2024", "max_results": 8}',
    feedbackHint: 'Compact: "[N] title\n  url\n  snippet", structured sources.',
  },
  {
    name: 'web_fetch',
    category: 'web',
    blockedInPlan: false,
    description:
      'Fetch a URL and return its content as clean HTML (noise removed, structure preserved). ' +
      'Removes scripts/styles/nav/footer/ads but PRESERVES headings, links, code blocks, articles, data-cerveau-* attributes — ' +
      'compatible with brain_record capture and brain_query_css structural queries. ' +
      'Handles redirects, Cloudflare bot detection, and proper browser headers. ' +
      'Content is truncated to max_chars (default 6000, max 120000). Use after web_search to read a specific page. ' +
      'Supports timeout_secs (default 30, max 120). URL is normalized (https:// added if missing). ' +
      'Do NOT use web_fetch for project files — use read_file instead.',
    schema: '{"url": "https://docs.example.com/api", "max_chars": 6000, "timeout_secs": 30}',
    feedbackHint: 'Clean HTML content (structure preserved for Brain), prefix with URL and content-type.',
  },
  {
    name: 'check_url',
    category: 'web',
    blockedInPlan: false,
    description:
      'Verify a local or remote page responds and contains expected text — prefer this over spawning your own ' +
      'server (npx http-server, python -m http.server) to self-check a deliverable. Bounded to 8s and works ' +
      'against http://127.0.0.1:<port> as well as public URLs. NEVER fails the tool call: a dead server, a ' +
      'timeout, or a blocked cross-origin read all come back as an honest {"status": 0} result instead of an ' +
      'error. Returns JSON {status, bodyStart, containsMatch} — status is the HTTP status code (0 if ' +
      'unreachable), bodyStart is the first 500 chars of the response body, containsMatch is true/false ' +
      'reflecting whether `contains` was found anywhere in the body (always false when `contains` is omitted). ' +
      'Do NOT use web_fetch for a localhost URL — it blocks loopback targets by design; use check_url instead.',
    schema: '{"url": "http://127.0.0.1:8123", "contains": "Hello"}',
    feedbackHint: 'JSON: {status, bodyStart(500 chars), containsMatch}. status 0 IS the honest failure signal, not an error string.',
  },
];

const BRAIN_TOOLS: ToolDef[] = [
  {
    name: 'brain_query',
    category: 'brain',
    blockedInPlan: false,
    description:
      'Search the project brain for prior knowledge: decisions, rules, past successes/failures, code context. ' +
      'SEMANTIC fuzzy recall — good for "how is auth configured?" or "what went wrong last time with X?". ' +
      'ALWAYS brain_query BEFORE attempting a task you are unsure about — the brain may have the answer. ' +
      'Returns notes with #ids to cite. Use brain_neighbours to follow a hit\'s graph. ' +
      'Do NOT use brain_query for exact structural queries — use brain_query_css instead. ' +
      'Do NOT use brain_query for web questions — use web_search instead.',
    schema: '{"query": "how to configure auth in this project"}',
    feedbackHint: 'Formatted brain context with #ids, or "No brain results for query".',
  },
  {
    name: 'brain_query_css',
    category: 'brain',
    blockedInPlan: false,
    description:
      'DETERMINISTIC structural recall — a CSS selector over notes\' data-cerveau-* attributes. ' +
      'Use for exact sets brain_query cannot nail: all active decisions, all warnings, notes touching a path, contradictions. ' +
      'Vocabulary: data-cerveau-type (decision|rule|episodic); data-cerveau-valid-until (present = stale, exclude with :not()); ' +
      'data-cerveau-saliency-kind (e.g. "contradiction"); data-cerveau-tier (working|archival). ' +
      'Warnings are <aside role="doc-warning">. File refs are <data value="src/...">. ' +
      'Example: article[data-cerveau-type="decision"]:not([data-cerveau-valid-until]) → all active decisions. ' +
      'Returns note #ids + text per hit.',
    schema: '{"selector": "article[data-cerveau-type=\'decision\']:not([data-cerveau-valid-until])", "limit": 50}',
  },
  {
    name: 'brain_neighbours',
    category: 'brain',
    blockedInPlan: false,
    description:
      'Follow a note\'s 1-hop graph: supersession chains (replaces/replaced-by), shared entities, clusters. ' +
      'Pass an id from brain_query_css or brain_query. ' +
      'Use to answer "what replaced this decision?" or "what else touches auth?".',
    schema: '{"id": "decision-oauth-pkce-2026-06-01"}',
  },
  {
    name: 'brain_record',
    category: 'brain',
    blockedInPlan: true,
    description:
      'Record a discovery, success, or failure to the brain for future agents. ' +
      'ALWAYS brain_record when you solve something for the first time — future agents will succeed faster. ' +
      'kind: "success" (working approach), "failure" (what went wrong + cause), "discovery" (project quirk, convention). ' +
      'Tags help future recall — use meaningful project-specific tags. ' +
      'Do NOT record trivial things (file paths you can find with search_code).',
    schema: '{"kind": "success|failure|discovery", "title": "short title", "description": "what happened and how", "tags": ["auth", "config"]}',
  },
  {
    name: 'brain_synthesize',
    category: 'brain',
    blockedInPlan: false,
    description:
      'Synthesize multiple brain notes about a topic into a concise summary. ' +
      'Use when brain_query returns many hits and you need a consolidated view. ' +
      'Returns a synthesized paragraph + list of source note #ids. ' +
      'Do NOT use brain_synthesize for single-note lookup — use brain_query or brain_neighbours instead.',
    schema: '{"topic": "authentication architecture", "max_notes": 10}',
  },
];

// W-CODE — user-authored "transformation" tools (transformTools.ts): a
// project-scoped catalog of pure `(input) => output` JS functions, executed
// in transformSandbox.ts's isolated worker/vm (zero fs/network/process
// access — see that module's header for the full threat model). Neither
// tool here is blocked in plan mode: a pure computation has no side effects
// on the project for plan mode's read-only guarantee to protect against.
const TRANSFORM_TOOLS: ToolDef[] = [
  {
    name: 'list_transforms',
    category: 'transform',
    blockedInPlan: false,
    description:
      'List every user-authored "transformation" tool defined for this project (name, id, description). ' +
      'A transformation is a pure JS function the user wrote — no fs/network access, sandboxed, JSON in and JSON out. ' +
      'ALWAYS call this BEFORE run_transform to discover the exact tool_id to pass — tool_ids are project-specific and not guessable. ' +
      'Returns "No transformation tools defined for this project" when the catalog is empty.',
    schema: '{}',
    feedbackHint: 'Compact: "id — name: description", one per line.',
  },
  {
    name: 'run_transform',
    category: 'transform',
    blockedInPlan: false,
    description:
      'Run one user-authored transformation tool against a JSON input and return its JSON output. ' +
      'The tool runs in an isolated sandbox with NO access to files, network, or the OS — pure computation only. ' +
      'input must be JSON-serializable; output is capped in size and must be JSON-serializable too. ' +
      'A hard ~1s timeout applies — an infinite loop or long-running computation is terminated and reported as an error, never hangs the mission. ' +
      'Use list_transforms first to find the right tool_id — do NOT guess one.',
    schema: '{"tool_id": "the id from list_transforms", "input": {"any": "JSON value"}}',
    feedbackHint: 'Return the JSON result, or "ERROR: transformation \'<name>\' failed: <reason>" on failure/timeout/oversize.',
  },
];

const MCP_TOOLS: ToolDef[] = [
  {
    name: 'mcp_list_tools',
    category: 'mcp',
    blockedInPlan: false,
    description:
      'List all tools available from connected MCP (Model Context Protocol) servers. ' +
      'MCP servers provide access to external services like Sentry, Slack, Notion, Linear, Figma, Datadog, etc. ' +
      'Returns each tool with its server name, tool name, and description. ' +
      'Use BEFORE mcp_call to discover available tools and their parameters.',
    schema: '{"server": "optional/server-name to filter to one server"}',
    feedbackHint: 'Compact: "server/tool — description", one per line.',
  },
  {
    name: 'mcp_call',
    category: 'mcp',
    blockedInPlan: false,
    description:
      'Call a tool on a connected MCP (Model Context Protocol) server. ' +
      'server: the MCP server name (from mcp_list_tools). tool: the tool name on that server. ' +
      'arguments: JSON object with the tool-specific parameters (check mcp_list_tools for schema). ' +
      'Use for accessing external services: Sentry errors, Slack messages, Notion docs, Linear tickets, Figma designs, Datadog metrics, etc. ' +
      'Returns the tool result as a JSON string.',
    schema: '{"server": "sentry", "tool": "list_errors", "arguments": {"project": "my-app", "limit": 10}}',
    feedbackHint: 'Return the JSON result, or "ERROR: ..." on failure.',
  },
];

const BROWSER_TOOLS: ToolDef[] = [
  {
    name: 'browser_open',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Open a visible browser window (Chromium via Playwright) for visual automation. ' +
      'The browser window is shown to the user — they can see what the agent does in real-time. ' +
      'Use for E2E testing, visual verification, screenshot capture, or web interaction that requires a real browser. ' +
      'Returns "Browser opened" on success. Only one browser instance at a time.',
    schema: '{"headless": false}',
    feedbackHint: 'Return "Browser opened" or "ERROR: ...".',
  },
  {
    name: 'browser_navigate',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Navigate the browser to a URL. Requires browser_open first. ' +
      'Returns the page title and URL after navigation completes.',
    schema: '{"url": "https://example.com"}',
    feedbackHint: 'Return "Navigated to <url> — title: <title>".',
  },
  {
    name: 'browser_click',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Click an element in the browser by CSS selector, text content, or Playwright ref. ' +
      'selector: CSS selector (e.g. "#submit-btn"), text: clickable text (e.g. "Sign in"), or ref: Playwright snapshot ref (e.g. "e3"). ' +
      'Requires browser_open + browser_navigate first.',
    schema: '{"selector": "#submit-btn", "text": "optional/clickable text", "ref": "optional/playwright-ref"}',
    feedbackHint: 'Return "Clicked <selector>" or "ERROR: element not found".',
  },
  {
    name: 'browser_fill',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Fill an input field in the browser. selector: CSS selector for the input. value: text to type. ' +
      'Requires browser_open + browser_navigate first. Clears the field before typing.',
    schema: '{"selector": "#email", "value": "user@example.com"}',
    feedbackHint: 'Return "Filled <selector> with <value>" or "ERROR: ...".',
  },
  {
    name: 'browser_screenshot',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Take a screenshot of the current browser page. Returns a description of the page state and any visible changes. ' +
      'The screenshot is visible to the user in the browser window. ' +
      'Requires browser_open + browser_navigate first.',
    schema: '{"full_page": false}',
    feedbackHint: 'Return a text description of the page state.',
  },
  {
    name: 'browser_snapshot',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Get a semantic accessibility snapshot of the browser page. ' +
      'Returns interactive elements with their ref IDs (e.g. [ref=e1]) for use with browser_click. ' +
      'Use to discover clickable elements, inputs, and page structure. ' +
      'Requires browser_open + browser_navigate first.',
    schema: '{}',
    feedbackHint: 'Return element list with refs, truncated at 2000 chars.',
  },
  {
    name: 'browser_close',
    category: 'browser',
    blockedInPlan: false,
    description:
      'Close the browser window and clean up the Playwright process. ' +
      'Use when browser automation is complete. The user can also close the browser window manually.',
    schema: '{}',
    feedbackHint: 'Return "Browser closed" or "ERROR: ...".',
  },
];

const ORCHESTRATION_TOOLS: ToolDef[] = [
  {
    name: 'delegate',
    category: 'orchestration',
    blockedInPlan: false,
    description:
      'Delegate a sub-task to a sub-agent. The sub-agent runs independently and returns a text result. ' +
      'Use for parallelizable work: "explore the test structure", "research this API". ' +
      'The sub-agent has read-only access by default. ' +
      'Do NOT use delegate for sequential tasks — do them yourself with the other tools.',
    schema: '{"task": "explore the auth module and list all endpoints", "agent": "optional/explore"}',
    feedbackHint: 'Return sub-agent\'s text result, prefixed with "[delegated]".',
  },
  {
    name: 'ask_user',
    category: 'orchestration',
    blockedInPlan: false,
    description:
      'Ask the human a clarifying question. Use when you are genuinely blocked and cannot proceed without input. ' +
      'Provide 2-4 options when possible to make it easy for the human to respond. ' +
      'Do NOT use ask_user for things you can figure out with read_file, search_code, or brain_query — ' +
      'only use it when you truly cannot determine the right approach.',
    schema: '{"question": "Should I use OAuth or session-based auth?", "options": ["OAuth", "Sessions", "Both"]}',
    feedbackHint: 'Return the user\'s response, or "No response" if timed out.',
  },
  {
    name: 'find_tool',
    category: 'orchestration',
    blockedInPlan: false,
    description:
      'Look up the full definition (schema + ACI-optimized usage notes) of a tool that is only advertised as a ' +
      'one-line hint in the "Other available tools" index above — most tools are lazy-loaded that way to save ' +
      'context, and find_tool fetches the real definition on demand (Claude Code / MCP-style deferred tool loading). ' +
      'query matches an exact tool name, a substring of a name, a tag (web, git, brain, files, front, vision), or a ' +
      'keyword in its description. Returns up to 5 matching definitions, most relevant first. ' +
      'Do NOT call find_tool for a tool whose full definition is already shown above (the core set) — that wastes a turn. ' +
      'Do NOT guess a non-core tool\'s argument shape without calling find_tool first.',
    schema: '{"query": "browser_click"}',
    feedbackHint: 'Return up to 5 full tool definitions (schema + description), or "No tool found matching ...".',
  },
];

// ── Cloud tools (Solari browser / desktop / sandbox) ────────────────
// All 31 are keyed by a mission context and report activity on the canvas
// event bus. Read-only tools are NOT blocked in plan mode; mutating tools are.

const CLOUD_TOOLS: ToolDef[] = [
  {
    name: 'cloud_browser_open',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Open (or reuse) the mission Solari browser session. Attach a saved profile_id; ' +
      'optionally enable stealth, a managed proxy (proxy_country), captcha solving, or ' +
      'recording. Output: the session id. Requires a mission context. Follow with ' +
      'cloud_browser_navigate.',
    schema: '{"profile_id": "optional", "stealth": false, "proxy_country": "us", "captcha": false, "recording": false}',
  },
  {
    name: 'cloud_browser_close',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Close the mission Solari browser session and free its profile lock. Idempotent.',
    schema: '{}',
  },
  {
    name: 'cloud_browser_navigate',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Navigate the mission open browser to a URL. Output: the final URL and page title. ' +
      'Requires cloud_browser_open first.',
    schema: '{"url": "https://example.com"}',
  },
  {
    name: 'cloud_browser_read_page',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Read the current page accessibility snapshot (falls back to raw HTML). Output ' +
      'truncated to 2000 chars. Requires cloud_browser_open + cloud_browser_navigate.',
    schema: '{}',
  },
  {
    name: 'cloud_browser_click',
    category: 'cloud',
    blockedInPlan: true,
    description:
      'Click an element by CSS selector or visible text (provide exactly one). Mutates the ' +
      'page, so it is blocked in plan mode.',
    schema: '{"selector": "button#submit", "text": "Submit"}',
  },
  {
    name: 'cloud_browser_type',
    category: 'cloud',
    blockedInPlan: true,
    description:
      'Type text into an input field identified by selector. Mutates the page; blocked in ' +
      'plan mode.',
    schema: '{"selector": "input#q", "value": "text to type"}',
  },
  {
    name: 'cloud_browser_screenshot',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Capture a screenshot of the current page. The full data URL is emitted on the bus for ' +
      'the canvas panel; the observation is a short description. Requires an open session.',
    schema: '{"full_page": false}',
  },
  {
    name: 'cloud_browser_scroll',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Scroll the page by a pixel delta (dx, dy). Mutates view state; blocked in plan mode.',
    schema: '{"dx": 0, "dy": 300}',
  },
  {
    name: 'cloud_browser_wait',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Wait for a selector to appear, or for a fixed number of milliseconds. Provide selector ' +
      'or ms.',
    schema: '{"selector": "optional", "ms": 1000, "timeout": 30000}',
  },
  {
    name: 'cloud_browser_replay_url',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Return the presigned replay URL for the current browser session (available ~1-3s after ' +
      'the session is released and recording was enabled).',
    schema: '{}',
  },
  {
    name: 'cloud_browser_profiles_list',
    category: 'cloud',
    blockedInPlan: false,
    description: 'List saved Solari browser profiles (id + name). Observation-only.',
    schema: '{}',
  },
  {
    name: 'cloud_browser_profile_save',
    category: 'cloud',
    blockedInPlan: true,
    description:
      'Save the current session cookies/localStorage to a named profile. Mutates the profile ' +
      'store; blocked in plan mode.',
    schema: '{"profile_id": "required"}',
  },
  {
    name: 'cloud_desktop_open',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Ensure the shared Agent Computer exists and acquire its FIFO mutex for this mission. ' +
      'Output the desktop id. Follow with other cloud_desktop_* tools.',
    schema: '{}',
  },
  {
    name: 'cloud_desktop_close',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Release the Agent Computer mutex held by this mission. Idempotent.',
    schema: '{}',
  },
  {
    name: 'cloud_desktop_screenshot',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Capture a screenshot of the Agent Computer desktop. The data URL is emitted on the bus ' +
      'for the canvas panel.',
    schema: '{}',
  },
  {
    name: 'cloud_desktop_stream_url',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Return the live VNC stream URL (+ token) for viewing the desktop.',
    schema: '{}',
  },
  {
    name: 'cloud_desktop_mouse_click',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Click at absolute (x, y) desktop coordinates. Mutates the desktop; blocked in plan mode.',
    schema: '{"x": 0, "y": 0, "button": "left"}',
  },
  {
    name: 'cloud_desktop_mouse_move',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Move the mouse to absolute (x, y) coordinates. Blocked in plan mode.',
    schema: '{"x": 0, "y": 0}',
  },
  {
    name: 'cloud_desktop_keyboard_type',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Type a string on the desktop (into whichever element has focus). Blocked in plan mode.',
    schema: '{"text": "hello"}',
  },
  {
    name: 'cloud_desktop_keyboard_hotkey',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Press a key chord, e.g. ["ctrl", "c"]. Blocked in plan mode.',
    schema: '{"keys": ["ctrl", "c"]}',
  },
  {
    name: 'cloud_desktop_exec',
    category: 'cloud',
    blockedInPlan: true,
    description:
      'Run a shell command on the desktop. Output (exit/stdout/stderr) truncated to 2000 chars. ' +
      'Blocked in plan mode.',
    schema: '{"command": "ls -la", "cwd": "optional"}',
  },
  {
    name: 'cloud_desktop_clipboard_get',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Read the current text contents of the shared Agent Computer clipboard. Observation-only.',
    schema: '{}',
  },
  {
    name: 'cloud_desktop_clipboard_set',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Write text to the desktop clipboard. Mutates state; blocked in plan mode.',
    schema: '{"text": "clipboard content"}',
  },
  {
    name: 'cloud_desktop_file_write',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Write a file to the desktop filesystem. Blocked in plan mode.',
    schema: '{"path": "/workspace/out.txt", "content": "file content"}',
  },
  {
    name: 'cloud_sandbox_open',
    category: 'cloud',
    blockedInPlan: false,
    description:
      'Open (or reuse) the mission ephemeral Solari sandbox with the shared /workspace volume. ' +
      'Optional template/cpu/mem_mb.',
    schema: '{"template": "code", "cpu": 2, "mem_mb": 2048}',
  },
  {
    name: 'cloud_sandbox_close',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Kill the mission sandbox and remove it from the ledger. Idempotent.',
    schema: '{}',
  },
  {
    name: 'cloud_sandbox_read_file',
    category: 'cloud',
    blockedInPlan: false,
    description: 'Read a file from the sandbox filesystem. Output truncated to 2000 chars.',
    schema: '{"path": "/workspace/file.txt"}',
  },
  {
    name: 'cloud_sandbox_file_list',
    category: 'cloud',
    blockedInPlan: false,
    description: 'List the files and directories inside a sandbox path (defaults to the working directory).',
    schema: '{"path": "/workspace"}',
  },
  {
    name: 'cloud_sandbox_write_file',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Write a file to the sandbox filesystem. Mutates state; blocked in plan mode.',
    schema: '{"path": "/workspace/out.txt", "content": "file content"}',
  },
  {
    name: 'cloud_sandbox_exec',
    category: 'cloud',
    blockedInPlan: true,
    description:
      'Run a command in the sandbox. Output (exit/stdout/stderr) truncated to 2000 chars. ' +
      'Blocked in plan mode.',
    schema: '{"command": "pwd", "cwd": "optional"}',
  },
  {
    name: 'cloud_sandbox_preview_url',
    category: 'cloud',
    blockedInPlan: true,
    description: 'Return the public HTTPS preview URL for a port serving inside the sandbox.',
    schema: '{"port": 3000}',
  },
];

const BOT_TOOLS: ToolDef[] = [
  {
    name: 'bot_request_intervention',
    category: 'orchestration',
    blockedInPlan: false,
    description:
      'Ask the human to take over a LazyBot session for a step only a person can complete ' +
      '(login, 2FA, captcha, payment, ambiguous choice). Surfaces in the manager header ' +
      '(data-testid="bot-intervention-<botId>"). The bot run keeps going — do not guess secrets. ' +
      'Prefer this over ask_user when a live browser/desktop takeover is needed.',
    schema: '{"reason": "login|2fa|captcha|approval|ask_user", "detail": "url or short question"}',
    feedbackHint: 'Return that the human was notified and should take over the live session.',
  },
  {
    name: 'bot_handoff',
    category: 'orchestration',
    blockedInPlan: true,
    description:
      'Delegate a subtask to another saved LazyBot (by id or name). The child run is a real ' +
      'mission on the same project. Use when another bot\'s persona is a better fit. ' +
      'Does not stop the caller.',
    schema: '{"to": "bot_id_or_name", "task": "what the other bot should do", "context": "optional"}',
  },
];

// ── Registry ────────────────────────────────────────────────────────

export const ALL_TOOLS: readonly ToolDef[] = [
  ...NAVIGATION_TOOLS,
  ...EDIT_TOOLS,
  ...EXEC_TOOLS,
  ...GIT_TOOLS,
  ...WEB_TOOLS,
  ...BRAIN_TOOLS,
  ...TRANSFORM_TOOLS,
  ...MCP_TOOLS,
  ...BROWSER_TOOLS,
  ...CLOUD_TOOLS,
  ...BOT_TOOLS,
  ...ORCHESTRATION_TOOLS,
];

const TOOL_BY_NAME = new Map(ALL_TOOLS.map(t => [t.name, t]));

export function getTool(name: string): ToolDef | undefined {
  return TOOL_BY_NAME.get(name);
}

export function getToolNames(): string[] {
  return ALL_TOOLS.map(t => t.name);
}

export function getToolsByCategory(cat: ToolCategory): ToolDef[] {
  return ALL_TOOLS.filter(t => t.category === cat);
}

/** Tools blocked in plan (read-only) mode. */
export function getPlanBlockedTools(): Set<string> {
  return new Set(ALL_TOOLS.filter(t => t.blockedInPlan).map(t => t.name));
}

/** All tool names except FINAL (which is a control action, not a tool). */
export const TOOL_ACTION_NAMES = ALL_TOOLS.map(t => t.name);

/**
 * Renders a list of tools as "- name: schema\n  description" blocks, injecting
 * brain-learned overlays when present. Shared by buildToolSignatures (all
 * tools, unchanged default behavior) and toolRegistryLazy.ts's
 * buildLazyToolBlock (core subset), so both stay byte-identical in how they
 * format one tool's entry. Exported for that sibling module to reuse.
 */
export function renderToolSignatures(tools: readonly ToolDef[], overlays?: Map<string, string>): string {
  const lines: string[] = [];
  for (const tool of tools) {
    const overlay = overlays?.get(tool.name);
    const desc = overlay ? `${tool.description}\n  PROJECT KNOWLEDGE: ${overlay}` : tool.description;
    lines.push(`- ${tool.name}: ${tool.schema}`);
    lines.push(`  ${desc}`);
  }
  return lines.join('\n');
}

/**
 * Build the tool-signature block for the system prompt.
 * Each tool is listed with its name, schema, and ACI-optimized description.
 * This replaces the hardcoded tool list in AGENT_SYSTEM_PROMPT.
 *
 * ALWAYS renders every tool in ALL_TOOLS, in full — unchanged from before the
 * lazy-loading addition (./toolRegistryLazy.ts), so existing callers/tests
 * keep working byte-for-byte. Use toolRegistryLazy's buildLazyToolBlock for
 * the token-saving core+index split.
 */
export function buildToolSignatures(overlays?: Map<string, string>): string {
  return renderToolSignatures(ALL_TOOLS, overlays);
}

/**
 * Build the ACTION list (pipe-separated) for the ReAct protocol header.
 */
export function buildActionList(): string {
  return [...TOOL_ACTION_NAMES, 'FINAL'].join(' | ');
}

/**
 * Build the tools-policy block (which tools are blocked/allowed) for the
 * system prompt. Replaces the hardcoded PLAN_MODE_BLOCKED_TOOLS in
 * managedAgentPolicy.ts.
 */
export function buildToolPolicyBlock(
  permissionMode?: string,
  allowedTools?: string[],
  deniedTools?: string[],
): string {
  const lines: string[] = [];

  if (permissionMode === 'plan') {
    const blocked = getPlanBlockedTools();
    const blockedList = [...blocked].join(', ');
    lines.push(
      `- PLAN MODE (read-only): ${blockedList} are BLOCKED this run. ` +
      'Investigate with read_file, read_dir, find_file, search_code, brain_query, ' +
      'brain_query_css, brain_neighbours, git_status, git_diff, git_log, review_diff, ' +
      'web_search, web_fetch, then finish with ACTION: FINAL and your plan as the summary.',
    );
  }
  if (deniedTools && deniedTools.length > 0) {
    lines.push(`- DENIED TOOLS: ${deniedTools.join(', ')}. Do not attempt these — they will be blocked.`);
  }
  if (allowedTools && allowedTools.length > 0) {
    lines.push(`- ALLOWED TOOLS ONLY: ${allowedTools.join(', ')}. Any other tool will be blocked.`);
  }

  if (lines.length === 0) return '';
  return `\n\nACTIVE RESTRICTIONS FOR THIS RUN:\n${lines.join('\n')}`;
}

