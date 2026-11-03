// `BunvexAuthProvider` (STUDY-201 §3.4), upstream's `react/index.test.tsx` ported (5): a real `BunvexReactClient` on a
// made-up deployment URL (nothing authenticates or subscribes, so it never connects). Upstream checks the default
// `oauth()` with the OAuth hook, which comes with OAuth; here, through the value it publishes.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { BunvexReactClient } from "@bunvex/react";
import { makeFunctionReference } from "@bunvex/server";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import type { AmbientSignInClient, AuthSignInApi } from "../src/browser/ambientSignInClient.ts";
import { OAUTH_FLOW_ERROR_KEY, OAUTH_SETUP_ID } from "../src/methods/oauth/client.ts";
import { useAuthSignInApi } from "../src/react/client.tsx";
import { BunvexAuthProvider } from "../src/react/index.tsx";
import { useAmbientSignInValue } from "../src/react/methods.ts";

const API = {
  refreshSession: makeFunctionReference<"mutation">("auth:refreshSession"),
  signOut: makeFunctionReference<"mutation">("auth:signOut"),
} as never;

const clients: BunvexReactClient[] = [];
const makeClient = () => {
  const client = new BunvexReactClient("https://happy-animal-123.bunvex.example");
  clients.push(client);
  return client;
};

/** The value a probe setup publishes under its `status` key. */
function ProbeStatus() {
  return <div>{useAmbientSignInValue<string>("probe", "status") ?? "missing"}</div>;
}

/** The default `oauth()`'s flow error: `undefined` would mean it was never registered. */
function OauthFlowError() {
  return <div>{String(useAmbientSignInValue(OAUTH_SETUP_ID, OAUTH_FLOW_ERROR_KEY))}</div>;
}

describe("BunvexAuthProvider ambient sign-ins", () => {
  afterEach(async () => {
    cleanup();
    for (const c of clients.splice(0)) await c.close();
  });

  test("published setup values are readable on the first render", () => {
    const probe: AmbientSignInClient = {
      id: "probe",
      setup: (ctx) => {
        ctx.values.set("status", "registered");
      },
    };
    render(
      <BunvexAuthProvider client={makeClient()} api={API} ambientSignIns={[probe]}>
        <ProbeStatus />
      </BunvexAuthProvider>,
    );
    expect(screen.getByText("registered")).toBeDefined();
  });

  test("onInit runs once per client under StrictMode", () => {
    const onInit = mock();
    render(
      <StrictMode>
        <BunvexAuthProvider
          client={makeClient()}
          api={API}
          ambientSignIns={[{ id: "probe", setup: () => ({ onInit }) }]}
        >
          <div />
        </BunvexAuthProvider>
      </StrictMode>,
    );
    expect(onInit).toHaveBeenCalledTimes(1);
  });

  test("setups and hooks receive the same sign-in api", () => {
    const fromSetup: AuthSignInApi[] = [];
    const fromHook: AuthSignInApi[] = [];
    function Capture() {
      fromHook.push(useAuthSignInApi());
      return null;
    }
    render(
      <BunvexAuthProvider
        client={makeClient()}
        api={API}
        ambientSignIns={[{ id: "probe", setup: (ctx) => void fromSetup.push(ctx.signInApi) }]}
      >
        <Capture />
      </BunvexAuthProvider>,
    );
    expect(fromHook[0]).toBe(fromSetup[0]!);
  });

  test("the sign-in api routes through the bunvex client", async () => {
    const client = makeClient();
    const mutationSpy = spyOn(client, "mutation").mockResolvedValue("result" as never);
    const signIn = makeFunctionReference<"mutation">("auth:signInProbe");
    const captured: AuthSignInApi[] = [];
    function Capture() {
      captured.push(useAuthSignInApi());
      return null;
    }
    render(
      <BunvexAuthProvider client={client} api={API}>
        <Capture />
      </BunvexAuthProvider>,
    );
    expect(await captured[0]!.mutation(signIn as never, {} as never)).toBe("result" as never);
    expect(mutationSpy).toHaveBeenCalledWith(signIn, {});
  });

  test("oauth() is registered when no ambient sign-ins are given", () => {
    render(
      <BunvexAuthProvider client={makeClient()} api={API}>
        <OauthFlowError />
      </BunvexAuthProvider>,
    );
    expect(screen.getByText("null")).toBeDefined();
  });
});
