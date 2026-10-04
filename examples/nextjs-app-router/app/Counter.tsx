"use client";

import { type Preloaded, useMutation, usePreloadedQuery } from "bunvex/react";
import { api } from "../bunvex/_generated/api";

export function Counter(props: { preloaded: Preloaded<typeof api.counters.get> }) {
  // The server's value on the first render, then every change from any tab.
  const count = usePreloadedQuery(props.preloaded);
  const increment = useMutation(api.counters.increment);
  return (
    <p>
      Clicked {count} times.{" "}
      <button type="button" onClick={() => increment({ name: "clicks" })}>
        Click
      </button>
    </p>
  );
}
