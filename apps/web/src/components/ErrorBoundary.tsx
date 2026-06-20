import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Changing this value resets the boundary (e.g. on canvas/mode switch). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

// ErrorBoundary stops a transient render crash from white-screening the whole
// app. A live canvas takes a steady stream of state over WS; if one render
// throws (a malformed entity, a Leaflet hiccup on tab-back), we'd rather show a
// recoverable panel than a blank page that only a full reload fixes. The error
// is logged so the underlying cause is still diagnosable.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Canvas render error:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // A new resetKey (or recovered state arriving) clears the error so the next
    // render can try again.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="max-w-sm rounded-2xl border border-ink/10 bg-white px-6 py-5 text-center shadow-[3px_4px_0_rgba(17,17,17,0.08)]">
            <p className="text-sm font-semibold text-ink">Something glitched rendering the canvas</p>
            <p className="mt-1 text-xs text-ink/50">
              The connection is fine — this view hit a snag. Try again, and it'll pick up the latest state.
            </p>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
