// The ambient sign-ins' values in React (STUDY-201 §3.4), upstream's `react/methods.test.tsx` ported (3).
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SignInValues } from "../src/browser/keyedStore.ts";
import { AuthClient } from "../src/browser/sessionManager.ts";
import { InMemoryStorage } from "../src/browser/storage.ts";
import { AuthProvider } from "../src/react/client.tsx";
import { useAmbientSignInValue } from "../src/react/methods.ts";
import { stubSignInApi } from "./signInApi.ts";

const NAMESPACE = "https://happy-animal-123.bunvex.example";
const authApi = { refreshSession: async () => ({ kind: "noSession" as const }), signOut: async () => {} };

const makeClient = () =>
  new AuthClient({ mode: "spa", authApi, storage: new InMemoryStorage(), storageNamespace: NAMESPACE });

/** A client with a probe ambient sign-in, and the values its setup was handed (to write through). */
function makeProbeClient() {
  const probe: { values?: SignInValues } = {};
  const client = new AuthClient({
    mode: "spa",
    authApi,
    storage: new InMemoryStorage(),
    storageNamespace: NAMESPACE,
    ambientSignIns: {
      signIns: [
        {
          id: "probe",
          setup: (ctx) => {
            probe.values = ctx.values;
          },
        },
      ],
      signInApi: stubSignInApi().signInApi,
      bunvex: { mutation: mock() },
    },
  });
  if (probe.values === undefined) throw new Error("probe setup did not run");
  return { client, probeValues: probe.values };
}

const wrapperFor = (client: AuthClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <AuthProvider authClient={client} signInApi={stubSignInApi().signInApi}>
        {children}
      </AuthProvider>
    );
  };

describe("useAmbientSignInValue", () => {
  afterEach(cleanup);

  test("throws when used outside a provider", () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => renderHook(() => useAmbientSignInValue("probe", "greeting"))).toThrow(
        "useAmbientSignInValue must be used within a <BunvexAuthProvider>.",
      );
    } finally {
      error.mockRestore();
    }
  });

  test("returns undefined for an unregistered key", () => {
    const { result } = renderHook(() => useAmbientSignInValue("probe", "missing"), {
      wrapper: wrapperFor(makeClient()),
    });
    expect(result.current).toBeUndefined();
  });

  test("reads a value seeded before render and re-renders on set", () => {
    const { client, probeValues } = makeProbeClient();
    probeValues.set("greeting", "hello");
    const { result } = renderHook(() => useAmbientSignInValue<string>("probe", "greeting"), {
      wrapper: wrapperFor(client),
    });
    expect(result.current).toBe("hello");
    act(() => probeValues.set("greeting", "hi again"));
    expect(result.current).toBe("hi again");
  });
});
