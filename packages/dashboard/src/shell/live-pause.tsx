// Pausing a busy live list (STUDY-149 PR 6), as Convex's `usePausedLiveData.ts` with its list headers
// (`ScheduledFunctionsListHeader.tsx`, `FileStorageListHeader.tsx`): the user may pause the list's live updates
// and go live again; the source may pause them itself past 100 updates in 10 s (`LiveChange`), which the screen
// says ("There are too many updates…") and which keeps the toggle disabled for the rest of the visit, as Convex's
// `isRateLimited`. While paused the list changes only when asked (Refresh, one read); the parts Convex keeps live
// (the cron jobs, the file count) still follow. The pause is kept per deployment in this browser, as Convex keeps
// `<deployment>/pauseLiveScheduledJobs` and `…/pauseLiveFileStorage` in local storage.
import { Button } from "@bunvex/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { CirclePause, CirclePlay, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useQueryScope } from "../context.tsx";
import { deploymentQuery } from "../data/queries.ts";

export type LivePauseKey = "pauseLiveScheduledJobs" | "pauseLiveFileStorage";

export type LivePause = {
  /** Live updates of the list are off: by the user, or by the source. */
  paused: boolean;
  /** The source paused them in this visit (too many updates); going live is off until the screen opens again. */
  rateLimited: boolean;
  /** Changes on each "Go live": the list's watcher subscribes again, which resumes a source's paused list. */
  generation: number;
  /** The source said it paused the list (`LiveChange.paused`); ignored while already paused, as Convex's counter. */
  onSourcePaused: () => void;
  setPaused: (paused: boolean) => void;
};

export const TOO_MANY_UPDATES = "There are too many updates to show live. Updates have automatically been paused.";

const storageKey = (deployment: string, key: LivePauseKey) => `bunvex:${deployment}/${key}`;

function readPaused(key: string | null): boolean {
  if (key === null) return false;
  try {
    return localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

export function useLivePause(key: LivePauseKey): LivePause {
  const scope = useQueryScope();
  const { data: deployment } = useQuery(deploymentQuery(scope));
  const stored = deployment ? storageKey(deployment.name, key) : null;
  // the stored choice is read once the deployment's name is known (a choice made before that is kept)
  const [state, setState] = useState<{ key: string | null; paused: boolean }>(() => ({
    key: stored,
    paused: readPaused(stored),
  }));
  if (state.key !== stored && stored !== null) setState({ key: stored, paused: readPaused(stored) || state.paused });
  const [rateLimited, setRateLimited] = useState(false);
  const [generation, setGeneration] = useState(0);
  const setPaused = (paused: boolean) => {
    setState((s) => ({ ...s, paused }));
    if (!paused) setGeneration((g) => g + 1);
    if (stored !== null)
      try {
        localStorage.setItem(stored, String(paused));
      } catch {
        // storage off: the choice lasts for this visit
      }
  };
  return {
    paused: state.paused,
    rateLimited,
    generation,
    onSourcePaused: () => {
      if (state.paused) return;
      setRateLimited(true);
      setPaused(true);
    },
    setPaused,
  };
}

/** The list's live controls (Convex's header buttons): the warning, Refresh while paused, Pause / Go live. */
export function LiveControls(props: {
  pause: LivePause;
  /** What the list shows, for the tips: "scheduled functions", "files". */
  what: string;
  onRefresh: () => void;
  refreshing?: boolean;
}) {
  const { pause } = props;
  return (
    <span className="flex items-center gap-1">
      {pause.rateLimited && (
        <span
          role="img"
          aria-label="Live updates paused automatically"
          title={`Live updates have automatically been paused because the ${props.what} are updating too frequently in this deployment.`}
        >
          <TriangleAlert aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-400" />
        </span>
      )}
      {pause.paused && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Refresh"
          title={`Refresh the list of ${props.what}.`}
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={pause.rateLimited}
        title={
          pause.rateLimited
            ? `The ${props.what} are updating too frequently to show live updates.`
            : pause.paused
              ? "Resume to show live updates."
              : "Pause to prevent live updates."
        }
        onClick={() => pause.setPaused(!pause.paused)}
      >
        {pause.paused ? <CirclePlay aria-hidden="true" /> : <CirclePause aria-hidden="true" />}
        {pause.paused ? "Go live" : "Pause"}
      </Button>
    </span>
  );
}

/** Convex's toast when the source pauses the list, as a line of the screen. */
export function LivePausedNotice({ pause }: { pause: LivePause }) {
  return (
    <p role="status" className="px-4 text-sm text-muted-foreground empty:hidden md:px-6">
      {pause.rateLimited ? TOO_MANY_UPDATES : ""}
    </p>
  );
}
