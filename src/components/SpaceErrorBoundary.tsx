import { Component, type ReactNode } from 'react';
import { reportReactBoundaryError } from '../lib/crashReporter';

interface SpaceErrorBoundaryProps {
  name: string;
  children: ReactNode;
}

interface SpaceErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class SpaceErrorBoundary extends Component<SpaceErrorBoundaryProps, SpaceErrorBoundaryState> {
  constructor(props: SpaceErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): SpaceErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[SpaceErrorBoundary:${this.props.name}]`, error, info.componentStack);
    reportReactBoundaryError(this.props.name, error, info.componentStack ?? undefined);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 12,
            padding: 24,
            background: 'var(--color-panel, #0E0E12)',
            color: 'rgba(255,255,255,0.5)',
          }}
        >
          <div
            style={{
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
            }}
          >
            !
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)' }}>
            {this.props.name} crashed
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'rgba(255,255,255,0.3)',
              maxWidth: 400,
              textAlign: 'center',
              fontFamily: "'JetBrains Mono', monospace",
              whiteSpace: 'pre-wrap',
            }}
          >
            {this.state.error?.message ?? 'Unknown error'}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
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
            }}
          >
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
