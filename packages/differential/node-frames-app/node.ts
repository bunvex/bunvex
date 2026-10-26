"use node";
// https-proxy-agent in a "use node" action (STUDY-188 §X11): its agent-base tells an https request by looking for
// `node:https:` in a fresh stack when the request sets neither `secureEndpoint` nor `protocol`; and what an app's own
// `error.stack` shows of Node's frames under an `https.request` call.
import http from "node:http";
import https from "node:https";
import { actionGeneric } from "convex/server";
import { HttpsProxyAgent } from "https-proxy-agent";

/** An https request through the agent, made and dropped at once: whether it was refused when made. */
function request(agent: http.Agent): string | null {
  try {
    const req = https.request({ host: "127.0.0.1", port: 9, path: "/", agent });
    req.on("error", () => {});
    req.destroy();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export const proxied = actionGeneric({
  args: {},
  handler: async () => {
    const agent = new HttpsProxyAgent("http://127.0.0.1:9");
    // What agent-base answers for the request's protocol, asked again from the app (no `https` frame here).
    return { threw: request(agent), outside: agent.protocol };
  },
});

/** An agent that keeps the stack of each read of its protocol, as agent-base reads it. */
class Watching extends http.Agent {
  stacks: string[] = [];
  get protocol() {
    this.stacks.push(String(new Error().stack));
    return "https:";
  }
  set protocol(_v: string) {}
}

export const stack = actionGeneric({
  args: {},
  handler: async () => {
    const agent = new Watching();
    const threw = request(agent);
    return { threw, stack: agent.stacks[0] ?? null };
  },
});
