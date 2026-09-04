import { Component, type ReactNode } from 'react';
import { reportReactBoundaryError } from '../lib/crashReporter';

interface RootErrorBoundaryProps {
  children: ReactNode;
}

interface RootErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/* RootErrorBoundary — last-resort, app-wide error boundary.

   SpaceErrorBoundary (see SpaceErrorBoundary.tsx) only wraps the ACTIVE
   space's content, so a throw during render of anything else in AppShell
   (SpacesRail, Omnibar, CommandPalette, UpdaterService,
   OnboardingModal — none of which sit inside a space) had no ancestor
   error boundary at all. React unmounts the whole tree on an uncaught
   render error, so the webview went fully white/blank with no recovery
   path — the exact "missing-import crash = white/black screen" pattern.

   This wraps the entire AppShell (see AppShell.tsx) so any such throw
   renders a minimal, dependency-free fallback instead: no i18n / context
   reliance (mirrors SpaceErrorBoundary's own self-contained style, and
   avoids the fallback itself depending on whatever broke), just a plain
   message plus a Reload action that reloads the webview.
*/
export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): RootErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[RootErrorBoundary]', error, info.componentStack);
    reportReactBoundaryError('RootErrorBoundary', error, info.componentStack ?? undefined);
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={styles.overlay}>
          <div style={styles.icon}>!</div>
          <div style={styles.title}>Lazy hit an unexpected error</div>
          <div style={styles.message}>
            {this.state.error?.message ?? 'Unknown error'}
          </div>
          <button onClick={this.handleReload} style={styles.button}>
            Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

const styles = {
  overlay: {
    position: 'fixed' as const,
    inset: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    background: 'var(--color-bg, #0A0A0E)',
    color: 'rgba(255,255,255,0.5)',
    zIndex: 9999,
  },

  icon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    background: 'rgba(240,113,120,0.1)',
    border: '1px solid rgba(240,113,120,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 22,
    color: '#F07178',
  },

  title: {
    fontSize: 14,
    fontWeight: 600,
    color: 'rgba(255,255,255,0.7)',
  },

  message: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.3)',
    maxWidth: 400,
    textAlign: 'center' as const,
    fontFamily: "'JetBrains Mono', monospace",
    whiteSpace: 'pre-wrap' as const,
  },

  button: {
    marginTop: 8,
    padding: '6px 16px',
    borderRadius: 6,
    background: 'rgba(124,92,255,0.15)',
    border: '1px solid rgba(124,92,255,0.3)',
    color: '#A78BFF',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
} as const;
