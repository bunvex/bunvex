import { describe, expect, test } from "bun:test";
import { Dashboard } from "@bunvex/dashboard";
import { MockDataSource } from "@bunvex/dashboard/mock";
import { createMemoryHistory } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { isAuthProvider } from "../src/contract-auth.ts";
import { expectAccessible } from "./axe.ts";

const NOW = Date.UTC(2026, 8, 29, 12);
const mockSource = (opts: Partial<ConstructorParameters<typeof MockDataSource>[0]> = {}) =>
  new MockDataSource({ seed: 7, now: NOW, executions: 5, documents: { tasks: 3, users: 3 }, ...opts });

function mount(source = mockSource()) {
  render(
    <Dashboard dataSource={source} history={createMemoryHistory({ initialEntries: ["/settings/authentication"] })} />,
  );
  return source;
}
// Settings → Authentication now opens Authentication → Sign in / Providers (UI-01 §25): the token providers there
const section = () => screen.findByRole("region", { name: "Token providers" });
const values = (item: HTMLElement) =>
  Object.fromEntries(
    [...item.querySelectorAll("dt")].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.querySelector("code")?.textContent,
    ]),
  );

describe("the auth providers' shape (the contract's check)", () => {
  test("OIDC and custom JWT, as Convex declares them", () => {
    expect(isAuthProvider({ domain: "https://a.dev", applicationID: "app" })).toBe(true);
    expect(isAuthProvider({ domain: "", applicationID: "app" })).toBe(false);
    const jwt = { type: "customJwt", issuer: "https://i", jwks: "https://i/jwks", algorithm: "RS256" } as const;
    expect(isAuthProvider(jwt)).toBe(true);
    expect(isAuthProvider({ ...jwt, algorithm: "HS256" as never })).toBe(false);
  });
});

describe("the token providers (was Settings → Authentication)", () => {
  test("each provider with its values, each copyable", async () => {
    mount();
    const s = await section();
    const oidc = await within(s).findByRole("listitem", { name: "OIDC provider: https://clerk.example.dev" });
    expect(values(oidc)).toEqual({ Domain: "https://clerk.example.dev", "Application ID": "bunvex" });
    const jwt = within(s).getByRole("listitem", { name: "Custom JWT provider: https://auth.example.com" });
    expect(values(jwt)).toEqual({
      Issuer: "https://auth.example.com",
      "JWKS URL": "https://auth.example.com/.well-known/jwks.json",
      Algorithm: "RS256",
      "Application ID": "bunvex-app",
    });
    expect(within(jwt).getByRole("button", { name: "Copy the JWKS URL" })).toBeDefined();
    await expectAccessible();
  });

  test("none configured: it says so, and where they are declared", async () => {
    mount(mockSource({ authProviders: [] }));
    const s = await section();
    await within(s).findByText(/no authentication providers yet/);
    expect(within(s).getByText("auth.config.ts")).toBeDefined();
  });

  test("a credential without environment-variable access cannot see it", async () => {
    const src = mockSource({ capabilities: { operations: ["viewData", "writeData"], readOnly: false } });
    let asked = false;
    const list = src.listAuthProviders.bind(src);
    src.listAuthProviders = (o) => {
      asked = true;
      return list(o);
    };
    mount(src);
    const s = await section();
    await within(s).findByText(/cannot view the authentication configuration/);
    expect(asked).toBe(false);
  });

  test("the old address opens Sign in / Providers; without auth providers that page has no token section", async () => {
    const src = mockSource();
    (src as { listAuthProviders?: unknown }).listAuthProviders = undefined;
    mount(src);
    await screen.findByRole("heading", { level: 1, name: "Sign in / Providers" });
    await screen.findByRole("checkbox", { name: "Google" });
    expect(screen.queryByRole("region", { name: "Token providers" })).toBeNull();
  });
});
