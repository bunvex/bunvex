// How a screen says its data did not come: what failed, in plain words, and what to do about it.
import { Button } from "@bunvex/ui/components/button";
import type { DataSourceError } from "../data-source.ts";

const HEADLINE: Record<DataSourceError["code"], string> = {
  unauthorized: "Not allowed to read this deployment",
  not_found: "Not found",
  invalid_request: "The dashboard sent a request the deployment rejected",
  unavailable: "The deployment did not answer",
};

const ADVICE: Record<DataSourceError["code"], string> = {
  unauthorized: "Check the admin key or sign in again.",
  not_found: "It may have been deleted or renamed.",
  invalid_request: "Reload the page. If it happens again, it is a bug in the dashboard.",
  unavailable: "Check that the server is running, then try again.",
};

export function ErrorState({ error, onRetry }: { error: DataSourceError; onRetry?: () => void }) {
  return (
    <div role="alert" className="border border-destructive/40 bg-destructive/10 p-4 text-sm">
      <p className="font-medium text-destructive">{HEADLINE[error.code]}</p>
      <p className="mt-1 text-foreground">
        {ADVICE[error.code]} <span className="text-muted-foreground">({error.message})</span>
      </p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
