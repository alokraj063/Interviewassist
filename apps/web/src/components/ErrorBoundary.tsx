import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: (error: Error, retry: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error("[error-boundary]", error, info);
  }

  retry = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.retry);
      }
      return (
        <div className="min-h-[60vh] flex items-center justify-center p-10">
          <div className="bg-card border border-border rounded-lg p-6 max-w-md text-center">
            <AlertTriangle className="w-10 h-10 text-warning mx-auto mb-3" />
            <div className="text-lg font-semibold mb-1">Something went wrong</div>
            <div className="text-sm text-muted-foreground mb-4">
              {this.state.error.message || "An unexpected error occurred."}
            </div>
            <Button onClick={this.retry} variant="outline" size="sm">
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              Try again
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
