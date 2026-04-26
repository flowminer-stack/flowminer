import React, { Component, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex min-h-[300px] items-center justify-center p-8">
          <div className="text-center">
            <AlertCircle className="mx-auto mb-3 h-8 w-8 text-danger" />
            <h3 className="text-[14px] font-semibold text-fg">Something went wrong</h3>
            <p className="mt-1 max-w-md text-[12px] text-fg-muted">
              {this.state.error?.message || 'An unexpected error occurred'}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="btn-secondary mt-4 text-[12px]"
            >
              <RefreshCw size={13} />
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
