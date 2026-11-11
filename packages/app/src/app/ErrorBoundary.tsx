import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/** A crash in one screen becomes a recoverable page, never a blank WebView. Signed data is untouched. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[tally] screen crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="welcome">
        <div className="welcome-body">
          <h1 className="welcome-title">This screen hit a problem</h1>
          <p className="welcome-lede">Your tabs, agreements and payments are safe; they live in the signed record, not on this screen.</p>
          <p className="fineprint">{this.state.error.message}</p>
        </div>
        <div className="welcome-foot">
          <a className="btn btn-primary btn-block" href="/app">
            <span>Back to your tabs</span>
          </a>
        </div>
      </div>
    );
  }
}
