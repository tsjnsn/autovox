import { Component, type ReactNode } from 'react';

interface OverlayBoundaryProps {
  children: ReactNode;
  onClose: () => void;
  onCrash: (error: unknown) => void;
}

interface OverlayBoundaryState {
  crashed: boolean;
  message: string;
}

/** Keeps the faceplate on screen with a Fault label when the overlay throws while rendering. */
export class OverlayBoundary extends Component<
  OverlayBoundaryProps,
  OverlayBoundaryState
> {
  override state: OverlayBoundaryState = { crashed: false, message: '' };

  static getDerivedStateFromError(error: unknown): OverlayBoundaryState {
    return {
      crashed: true,
      message: error instanceof Error ? error.message : '',
    };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onCrash(error);
  }

  override render(): ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <div className="autovox-card">
        <div className="autovox-card__face">
          <header className="autovox-card__header">
            <h1 className="autovox-card__title">Autovox</h1>
            <button
              type="button"
              className="autovox-btn autovox-btn--ghost autovox-btn--close"
              onClick={this.props.onClose}
              aria-label="Close Autovox"
            >
              Close
            </button>
          </header>
          <div className="player">
            <div className="player__bar">
              <div className="player__scrub" aria-hidden="true">
                <div className="player__scrub-rail" />
              </div>
              <span
                className="player__label player__label--error"
                title={this.state.message || undefined}
                role="status"
              >
                Fault
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
