// An extension screen's search params (UI-01 §26). Extension routes are not in the router's types, so this
// reads the matched route's (validated) search loosely and writes it back with a typed patch.
import { useNavigate, useSearch } from "@tanstack/react-router";

export function useExtensionSearch<T extends Record<string, unknown>>(path: string) {
  const search = useSearch({ strict: false }) as T;
  const navigate = useNavigate();
  const set = (patch: Partial<T>, replace = false) =>
    void navigate({ to: path, search: (s: T) => ({ ...s, ...patch }), replace } as never);
  return [search, set] as const;
}
