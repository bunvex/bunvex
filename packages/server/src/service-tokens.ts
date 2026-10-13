// `getServiceToken` / `getServiceUrl` (STUDY-151 §4), as Convex's `convex/server` exports (impl/actions_impl.ts):
// a credential and the base URL of a hosted service, for actions only (their syscalls exist in the action
// environment alone). The one service, `"ai-gateway"`, is a hosted cloud service: a self-hosted deployment has no
// way to mint its token, and Convex's answers `AiGatewayUnavailable`. bunvex answers it to both functions (Convex
// still hands out the cloud gateway's URL from `getServiceUrl`: DV-491).

/** The services a token or URL can be asked for (Convex's `ServiceName`). */
export type ServiceName = "ai-gateway";

let actionRunning: () => boolean = () => false;

/** Set by the server: whether an action is running (where Convex's syscalls exist). */
export function setServiceCallContext(running: () => boolean) {
  actionRunning = running;
}

/** Convex's `AiGatewayUnavailable` (a bad request), in bunvex's words. */
export class AiGatewayUnavailableError extends Error {
  readonly code = "AiGatewayUnavailable";
  constructor(fn: string) {
    super(
      `\`${fn}("ai-gateway")\` isn't available on this deployment because the AI gateway is a hosted cloud service. Call your model provider directly with your own API key.`,
    );
  }
}

async function serviceCall(fn: string, syscall: string, service: unknown): Promise<string> {
  // Convex's `validateArg`, then the syscall: unknown outside an action, its argument parsed (serde's message).
  if (service === undefined) throw new TypeError(`Must provide arg 1 \`service\` to \`${fn}\``);
  if (!actionRunning()) throw new Error(`Unknown async operation ${syscall}`);
  if (service !== "ai-gateway") throw new Error(`unknown variant \`${String(service)}\`, expected \`ai-gateway\``);
  throw new AiGatewayUnavailableError(fn);
}

/** A token for `service`, to send as `Authorization: Bearer <token>` (Convex's); unavailable when self-hosted. */
export function getServiceToken(service: ServiceName): Promise<string> {
  return serviceCall("getServiceToken", "1.0/createServiceToken", service);
}

/** The base URL of `service` (Convex's); unavailable when self-hosted (DV-491). */
export function getServiceUrl(service: ServiceName): Promise<string> {
  return serviceCall("getServiceUrl", "1.0/getServiceUrl", service);
}
