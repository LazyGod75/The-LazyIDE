import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import { noRawPathOps } from './eslint-rules/no-raw-path-ops.js'

// Local, dependency-free plugin housing this repo's own rules — currently
// just no-raw-path-ops (see eslint-rules/no-raw-path-ops.js), which guards
// against the recurring "\\?\ verbatim-prefix" Windows path bug documented
// in src/lib/paths.ts's header (eight-plus prior fixes of the same shape).
const localPlugin = {
  rules: {
    'no-raw-path-ops': noRawPathOps,
  },
}

export default defineConfig([
  globalIgnores([
    '**/.claude/**',
    'dist/**',
    'coverage/**',
    'src-tauri/**',
    'node_modules/**',
    'e2e/**',
    '**/*.cjs',
    // .lazy/worktrees/ holds nested git worktrees (each with its own
    // tsconfig) used by the agent runtime — not app source. Ignoring all of
    // .lazy/ also covers the sibling JSON state/config files, which aren't
    // lintable anyway.
    '.lazy/**',
    // bench/polyglot/.vendor/ holds vendored third-party benchmark sources
    // (aider + polyglot-benchmark). Some are Liquid templates with .js
    // extensions ({% ... %}) that ESLint cannot parse — not app source.
    'bench/polyglot/.vendor/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      local: localPlugin,
    },
    rules: {
      'local/no-raw-path-ops': 'error',
      '@typescript-eslint/no-unused-vars': ['error', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // Pre-existing react-hooks patterns throughout the codebase — downgraded
      // to warn to keep them visible without blocking CI. Refactoring them is
      // deferred (too broad to do safely in a release-prep commit).
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      // HMR-only hint — not a correctness issue in a Tauri/Vite app.
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // Complexity ratchet for extracted modules — keep new splits under
    // these ceilings. Do NOT enable complexity globally: agentsStore /
    // managerEngine / locales would fail CI overnight. Expand this list
    // as more hotspots are extracted.
    files: [
      'src/lib/brain/brainGraphLoad.ts',
      'src/lib/brain/withTimeout.ts',
      'src/lib/brain/brainNoteLoad.ts',
      'src/lib/brain/recallBudget.ts',
      'src/lib/brain/brainOverlayFlags.ts',
      'src/lib/agents/transcriptCompact.ts',
      'src/lib/agents/managerActionDispatch.ts',
      'src/lib/agents/runMissionPrepare.ts',
      'src/lib/agents/runMissionWorktree.ts',
      'src/lib/agents/runMissionFanout.ts',
      'src/lib/agents/runMissionSettle.ts',
      'src/lib/agents/runMissionReview.ts',
      'src/lib/agents/runMissionRoute.ts',
      'src/lib/agents/runMissionFinish.ts',
      'src/lib/agents/planAndActLiveSupport.ts',
      'src/lib/agents/planAndActScripted.ts',
      'src/lib/agents/planAndActLiveViaRunner.ts',
      'src/lib/platform/webSessionFs.ts',
      'src/lib/platform/brainReachableCache.ts',
      'src/components/agents/canvas/chrome/canvasGesturePause.ts',
      'src/lib/teams/liveTeamAgents.ts',
      'src/lib/agents/afterEditDiagnostics.ts',
      'src/lib/agents/afterEditDiff.ts',
      'src/lib/agents/checkNativeBudget.ts',
      'src/lib/agents/captureOutcome.ts',
      'src/lib/agents/silenceWatchdog.ts',
      'src/lib/agents/afterEditCheckpoint.ts',
      'src/lib/agents/runMissionOpts.ts',
      'src/components/prefetchLazySpaces.ts',
      'src/lib/agents/planApprovalMeta.ts',
      'src/components/agents/canvas/nodes/missionLiveLine.ts',
      'src/lib/tools/syntaxGuard.ts',
      'src/lib/agents/chainFireOnce.ts',
      'src/lib/models/estimateUsageUsd.ts',
      'src/lib/agents/nativeAbort.ts',
      'src/lib/agents/budgetThreshold.ts',
      'src/lib/agents/schedulerHardware.ts',
      'src/lib/agents/budgetSupabaseHydrate.ts',
      'src/lib/agents/graph/compileOrchestratorNode.ts',
      'src/lib/agents/graph/compileOrchestratorJoins.ts',
      'src/lib/agents/bareActionSpans.ts',
      'src/lib/agents/formatMissionDetail.ts',
      'src/lib/agents/managerSessionGate.ts',
      'src/lib/brain/firstNonNull.ts',
      'src/lib/security/secretGuard.ts',
      'src/lib/security/publicTree.ts',
      'src/lib/auth/guestMode.ts',
      'src/lib/envCloud.ts',
      'src/lib/agents/planScopeDiffs.ts',
      'src/lib/agents/planScopeDiffIo.ts',
      'src/lib/agents/managerModelResolve.ts',
      'src/lib/agents/managerDynamicContext.ts',
      'src/lib/agents/managerStreamCompletion.ts',
      'src/lib/agents/managerTurnRetry.ts',
      'src/lib/agents/codeFileActivity.ts',
      'src/lib/agents/codeLiveFiles.ts',
      'src/lib/agents/harnessPathGlob.ts',
      'src/lib/agents/harnessParseRules.ts',
      'src/lib/agents/missionWhoLine.ts',
      'src/lib/agents/managedAgentParse.ts',
      'src/lib/agents/managedAgentVisualMeta.ts',
      'src/lib/agents/managedAgentCaps.ts',
      'src/lib/agents/managedAgentPrepare.ts',
      'src/lib/agents/managedAgentFinal.ts',
      'src/lib/agents/managedAgentExecute.ts',
      'src/lib/agents/managedAgentTurnError.ts',
      'src/lib/agents/managedAgentAftermath.ts',
      'src/lib/agents/managedAgentPure.ts',
      'src/lib/agents/managedAgentLoopGuard.ts',
      'src/lib/agents/managedAgentSteering.ts',
      'src/lib/agents/managedAgentObserve.ts',
      'src/lib/agents/managedAgentTurn.ts',
      'src/lib/agents/managedAgentAction.ts',
      'src/lib/agents/managedAgentLoop.ts',
      'src/components/settings/AccountTab.tsx',
      'src/components/settings/account/useAccountBilling.ts',
      'src/components/settings/account/creditsUsage.ts',
      'src/components/settings/account/accountPanelStyle.ts',
      'src/components/settings/account/CreditsUsageBlock.tsx',
      'src/components/settings/account/AccountUserCard.tsx',
      'src/components/settings/account/AccountCreditBanners.tsx',
      'src/components/settings/account/AccountTopupRow.tsx',
      'src/components/settings/account/AccountProBilling.tsx',
      'src/components/settings/account/AccountFreePlans.tsx',
      'src/components/settings/account/submitCustomTopup.ts',
      'src/lib/brain/brainWithSetup.ts',
      'src/components/brain/brainDialogChrome.ts',
      'src/components/brain/brainDialogFields.ts',
      'src/components/brain/BrainDialogShell.tsx',
      'src/components/brain/BrainField.tsx',
      'src/components/brain/PublishBrainDialog.tsx',
      'src/components/brain/ImportBrainDialog.tsx',
    ],
    rules: {
      complexity: ['error', 12],
      'max-depth': ['error', 4],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    // engine/ is the vendored LazyBrain sidecar (its own package.json,
    // "lazybrain" — a separate project embedded in this repo, not part of
    // the Lazy IDE app). local/no-raw-path-ops exists to steer callers
    // toward THIS repo's src/lib/paths.ts helpers, which engine/ code has
    // no reason to import — scoping the rule off here, rather than adding
    // engine/** to the top-level globalIgnores, keeps every other lint
    // rule (and engine/'s own conventions) unaffected.
    files: ['engine/**/*.{ts,tsx}'],
    rules: {
      'local/no-raw-path-ops': 'off',
    },
  },
])
