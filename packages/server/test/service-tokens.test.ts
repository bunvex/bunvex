// `getServiceToken` / `getServiceUrl` (STUDY-151 §4): action syscalls in Convex; the AI gateway is a hosted
// cloud service, so a self-hosted deployment answers `AiGatewayUnavailable` to both (DV-491 for the URL).
import { expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, Functions, query } from "../src/functions.ts";
import { getServiceToken, getServiceUrl } from "../src/index.ts";

async function functions() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const failure = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };
  return new Functions(engine).register("m", {
    token: action(async (_, { service }: { service?: string }) => failure(() => getServiceToken(service as never))),
    url: action(async () => failure(() => getServiceUrl("ai-gateway"))),
    inQuery: query(async () => failure(() => getServiceToken("ai-gateway"))),
  });
}

test("in an action: unavailable on a self-hosted deployment, both of them", async () => {
  const f = await functions();
  expect(await f.runAction("m:token", { service: "ai-gateway" })).toBe(
    '`getServiceToken("ai-gateway")` isn\'t available on this deployment because the AI gateway is a hosted cloud service. Call your model provider directly with your own API key.',
  );
  expect(await f.runAction("m:url", {})).toContain('`getServiceUrl("ai-gateway")` isn\'t available on this deployment');
});

test("Convex's argument checks: the service required, and only `ai-gateway`", async () => {
  const f = await functions();
  expect(await f.runAction("m:token", {})).toBe("Must provide arg 1 `service` to `getServiceToken`");
  expect(await f.runAction("m:token", { service: "other" })).toBe("unknown variant `other`, expected `ai-gateway`");
});

test("outside an action, the syscall does not exist (a query, or no function at all)", async () => {
  const f = await functions();
  expect(await f.runQuery("m:inQuery", {})).toBe("Unknown async operation 1.0/createServiceToken");
  await expect(getServiceUrl("ai-gateway")).rejects.toThrow("Unknown async operation 1.0/getServiceUrl");
});
