/* TestsPanel — runs project tests via platform.tests.run and shows results.
   Failures are fed into the Problems panel via editorStore.setDiagnostics.
   Clicking a failure opens the file at the reported line via editor:openFile bus event.
   Web mode: platform.tests.run rejects — shows honest "not available in demo" state.
*/

import { useState } from 'react';
import type { Platform, TestRunResult, TestFailure } from '../../lib/platform/types';
import { useEditorStore } from './editorStore';
import { useToast } from '../ui';
import { emit } from '../../lib/bus';
import { useI18n } from '../../i18n';

// ── Types ─────────────────────────────────────────────────────────

interface Props {
  platform: Platform;
  projectRoot: string;
}

type PanelState = 'idle' | 'running' | 'done' | 'error' | 'unavailable';

// ── Helpers ───────────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * B20: single source of truth for "did the run genuinely pass" — the old
 * UI derived the green "All tests passed" message from `failures.length
 * === 0` alone, independent of `result.ok`/`result.total`. A config error
 * (exit code != 0, 0 tests ever ran, so `failures` stays empty — there was
 * nothing to report a per-test failure FOR) produced exactly that: a FAIL
 * badge, "0 passed · 0 total", AND a simultaneous green "All tests passed"
 * — three contradictory signals in the same panel. `total === 0` is its
 * own honest "neutral" outcome (nothing ran, so neither pass nor fail is a
 * true claim), distinct from both a real pass and a real failure.
 */
type ResultStatus = 'pass' | 'fail' | 'neutral';

function deriveResultStatus(result: TestRunResult): ResultStatus {
  if (result.total === 0) return 'neutral';
  if (result.ok && result.failed === 0) return 'pass';
  return 'fail';
}

function FailureRow({ failure, onOpen }: { failure: TestFailure; onOpen: (f: TestFailure) => void }) {
  const [hovered, setHovered] = useState(false);
  const hasLocation = Boolean(failure.file);

  return (
    <div
      role={hasLocation ? 'button' : undefined}
      tabIndex={hasLocation ? 0 : undefined}
      onClick={() => hasLocation && onOpen(failure)}
      onKeyDown={(e) => {
        if (!hasLocation) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(failure);
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: '5px 12px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: hovered && hasLocation ? 'rgba(240,113,120,0.06)' : 'transparent',
        cursor: hasLocation ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: '#FCA5A5',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontWeight: 500,
        }}
        title={failure.name}
      >
        {failure.name}
      </div>
      <div
        style={{
          fontSize: 10,
          color: 'rgba(255,255,255,0.4)',
          marginTop: 2,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={failure.message}
      >
        {failure.message}
      </div>
      {failure.file && (
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', marginTop: 1 }}>
          {failure.file}{failure.line ? `:${failure.line}` : ''}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────

export function TestsPanel({ platform, projectRoot }: Props) {
  const { setDiagnostics } = useEditorStore();
  const { toast } = useToast();
  const { t } = useI18n();

  const [panelState, setPanelState] = useState<PanelState>('idle');
  const [result, setResult] = useState<TestRunResult | null>(null);
  const isWeb = platform.name === 'web';

  async function runTests() {
    if (!projectRoot) {
      toast(t('tests.noProject'), 'warning');
      return;
    }

    // Clear previous diagnostics from this source
    setDiagnostics('__tests__', 'Tests', []);
    setPanelState('running');
    setResult(null);

    try {
      const res = await platform.tests.run(projectRoot);
      setResult(res);
      setPanelState('done');

      // Feed failures into Problems panel
      if (res.failures.length > 0) {
        const items = res.failures.map(f => ({
          line: f.line ?? 1,
          message: `[${res.tool}] ${f.name}: ${f.message}`,
          severity: 'error' as const,
        }));
        setDiagnostics(
          '__tests__',
          'Tests',
          items,
        );
      }

      const status = deriveResultStatus(res);
      if (status === 'pass') {
        toast(t('tests.allPassed', { count: String(res.passed), duration: fmtDuration(res.durationMs) }), 'success', 3000);
      } else if (status === 'neutral') {
        toast(t('tests.noTestsRan'), 'warning', 4000);
      } else {
        toast(t('tests.someFailed', { count: String(res.failed) }), 'error', 4000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isDemo = isWeb || msg.includes('not available in demo') || msg.includes('not yet implemented');
      if (isDemo) {
        setPanelState('unavailable');
        toast(t('tests.notAvailable'), 'warning');
      } else {
        setPanelState('error');
        toast(t('tests.runFailed', { message: msg }), 'error');
      }
    }
  }

  function handleOpenFailure(failure: TestFailure) {
    if (!failure.file) return;
    emit('editor:openFile', { path: failure.file, line: failure.line });
  }

  // ── Render ─────────────────────────────────────────────────────

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Toolbar */}
      <div
        style={{
          padding: '4px 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={runTests}
          disabled={panelState === 'running'}
          style={{
            background: panelState === 'running' ? 'rgba(124,92,255,0.25)' : '#7C5CFF',
            border: 'none',
            borderRadius: 4,
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
            padding: '4px 12px',
            cursor: panelState === 'running' ? 'not-allowed' : 'pointer',
            opacity: panelState === 'running' ? 0.7 : 1,
            fontFamily: 'inherit',
          }}
        >
          {panelState === 'running' ? 'Running...' : 'Run Tests'}
        </button>

        {result && panelState === 'done' && (
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>
            {result.tool} &middot; {result.passed}/{result.total} passed &middot; {fmtDuration(result.durationMs)}
          </span>
        )}

        {result && panelState === 'done' && (() => {
          const status = deriveResultStatus(result);
          const badgeColor = status === 'pass' ? '#66E27A' : status === 'fail' ? '#F07178' : '#FFC76B';
          const badgeBg = status === 'pass' ? 'rgba(102,226,122,0.1)' : status === 'fail' ? 'rgba(240,113,120,0.1)' : 'rgba(255,199,107,0.1)';
          const badgeLabel = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : t('tests.badge.neutral');
          return (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 10,
                fontWeight: 600,
                color: badgeColor,
                background: badgeBg,
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              {badgeLabel}
            </span>
          );
        })()}
      </div>

      {/* Content area */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Idle: hint */}
        {panelState === 'idle' && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,0.15)',
              fontSize: 12,
              padding: 24,
              textAlign: 'center',
            }}
          >
            Click &ldquo;Run Tests&rdquo; to execute the project test suite
          </div>
        )}

        {/* Running: spinner placeholder */}
        {panelState === 'running' && (
          <div
            style={{
              padding: '16px 12px',
              color: 'rgba(255,255,255,0.35)',
              fontSize: 12,
            }}
          >
            Running tests...
          </div>
        )}

        {/* Unavailable in demo */}
        {panelState === 'unavailable' && (
          <div
            style={{
              padding: '12px',
              background: 'rgba(255,199,107,0.06)',
              margin: '8px',
              borderRadius: 6,
              border: '1px solid rgba(255,199,107,0.15)',
              fontSize: 11,
              color: '#FFC76B',
            }}
          >
            Test runner is not available in web demo mode.
            <br />
            Open a real project in the Tauri desktop app to run tests.
          </div>
        )}

        {/* Error state */}
        {panelState === 'error' && (
          <div
            style={{
              padding: '12px',
              color: '#F07178',
              fontSize: 11,
            }}
          >
            Test run failed. Check the terminal for details.
          </div>
        )}

        {/* Results */}
        {panelState === 'done' && result && (
          <>
            {/* Summary bar */}
            <div
              style={{
                display: 'flex',
                gap: 12,
                padding: '6px 12px',
                fontSize: 11,
                borderBottom: '1px solid rgba(255,255,255,0.05)',
                color: 'rgba(255,255,255,0.5)',
                flexShrink: 0,
              }}
            >
              <span style={{ color: '#66E27A' }}>{result.passed} passed</span>
              {result.failed > 0 && (
                <span style={{ color: '#F07178' }}>{result.failed} failed</span>
              )}
              <span>{result.total} total</span>
            </div>

            {/* Failures */}
            {result.failures.length > 0 && (
              <div>
                <div
                  style={{
                    padding: '5px 12px 3px',
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: '0.06em',
                    color: 'rgba(255,255,255,0.3)',
                    textTransform: 'uppercase',
                  }}
                >
                  Failures
                </div>
                {result.failures.map((f, i) => (
                  <FailureRow
                    key={`${f.name}-${i}`}
                    failure={f}
                    onOpen={handleOpenFailure}
                  />
                ))}
              </div>
            )}

            {/* Genuine pass — only when tests actually ran AND passed (B20:
                previously this rendered whenever `failures.length === 0`,
                which is also trivially true for a 0-total vacuous run or a
                pre-test config error — producing a green "All tests
                passed" alongside the FAIL badge above). */}
            {result.failures.length === 0 && deriveResultStatus(result) === 'pass' && (
              <div
                style={{
                  padding: '16px 12px',
                  color: '#66E27A',
                  fontSize: 12,
                  textAlign: 'center',
                }}
              >
                {t('tests.allPassedInline', { count: String(result.passed) })}
              </div>
            )}

            {/* Neutral (0 tests ran) or a failure the tool reported no
                per-test detail for (e.g. a config error before any test
                executed) — never claim success; show the real command
                output instead of a fabricated pass/fail message. */}
            {result.failures.length === 0 && deriveResultStatus(result) !== 'pass' && (
              <div style={{ padding: '12px' }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: deriveResultStatus(result) === 'neutral' ? '#FFC76B' : '#F07178',
                    marginBottom: result.raw ? 8 : 0,
                  }}
                >
                  {deriveResultStatus(result) === 'neutral' ? t('tests.noTestsRan') : t('tests.runFailedNoDetail')}
                </div>
                {result.raw && (
                  <pre
                    style={{
                      margin: 0,
                      padding: '8px 10px',
                      background: 'rgba(0,0,0,0.25)',
                      borderRadius: 6,
                      fontSize: 10.5,
                      fontFamily: 'var(--font-mono)',
                      color: 'rgba(255,255,255,0.55)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 260,
                      overflowY: 'auto',
                    }}
                  >
                    {result.raw}
                  </pre>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
