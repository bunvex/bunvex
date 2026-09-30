// Where the function runner is opened from (STUDY-12 §7): a Run button, the header, or Ctrl+` anywhere.
import { createContext, useContext } from "react";

export type Runner = {
  /** The source can run functions and this credential may. */
  available: boolean;
  shown: boolean;
  /** Shows the runner, on `path` when given. */
  open: (path?: string) => void;
  close: () => void;
};

export const RunnerContext = createContext<Runner>({ available: false, shown: false, open: () => {}, close: () => {} });
export const useRunner = () => useContext(RunnerContext);
