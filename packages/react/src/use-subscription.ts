// Reading an external, changing value in a component, on React's `useSyncExternalStore` (the replacement
// Convex's `use_subscription.ts` itself names). The snapshot is recomputed only after the store notified (or
// right after subscribing, which catches a change between render and subscribe); in between, React gets the
// same object back, as `useSyncExternalStore` requires.
import { useCallback, useRef, useSyncExternalStore } from "react";

export function useSubscription<V>({
  getCurrentValue,
  subscribe,
}: {
  getCurrentValue: () => V;
  subscribe: (callback: () => void) => () => void;
}): V {
  const cache = useRef<{ getCurrentValue: () => V; value: V; stale: boolean } | null>(null);
  if (cache.current === null || cache.current.getCurrentValue !== getCurrentValue)
    cache.current = { getCurrentValue, value: getCurrentValue(), stale: false };

  const subscribeToStore = useCallback(
    (onChange: () => void) => {
      const unsubscribe = subscribe(() => {
        if (cache.current) cache.current.stale = true;
        onChange();
      });
      // React reads the snapshot again after subscribing: let it see what changed before.
      if (cache.current) cache.current.stale = true;
      return unsubscribe;
    },
    [subscribe],
  );
  const getSnapshot = () => {
    const c = cache.current!;
    if (c.stale) {
      c.stale = false;
      c.value = c.getCurrentValue();
    }
    return c.value;
  };
  return useSyncExternalStore(subscribeToStore, getSnapshot, getSnapshot);
}
