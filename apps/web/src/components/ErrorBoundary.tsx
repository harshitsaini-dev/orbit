import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StatusScreen } from './StatusScreen.js';

interface Props {
  children: ReactNode;
}

interface State {
  failed: boolean;
}

/**
 * The last line of defence: a component that throws while rendering would
 * otherwise unmount the whole tree and leave a blank white page, which tells
 * the user nothing and looks like the app was never there.
 *
 * Recovery is a remount rather than a reload, so the attempt is cheap and the
 * user keeps their place. If the fault is permanent the screen simply returns.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Left in deliberately: without it a crash in production is invisible, and
    // the component stack is the only thing that says which component threw.
    console.error('Orbit crashed while rendering', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <div className="status-shell">
        <StatusScreen
          kind="server-error"
          standalone
          detail="Orbit hit an unexpected error while drawing this page. Your files are untouched — nothing is stored here in the first place."
          onRetry={() => this.setState({ failed: false })}
        />
      </div>
    );
  }
}
