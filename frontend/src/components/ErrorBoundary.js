import React from 'react';

/** Keeps one broken page from blanking the whole app. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    console.error('Page error:', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page-error" role="alert">
        <h2 className="page-error__title">This page could not be shown</h2>
        <p>Try reloading. If it keeps happening, tell the server team.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
