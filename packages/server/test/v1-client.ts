// A bare sync-protocol v1 client for the server's tests: it sends messages and records what the server sends.
import { v1 } from "@bunvex/protocol";

/** The v1 sync URL of a server listening on `port`. */
export const syncUrl = (port: number | undefined) => `ws://127.0.0.1:${port}/api/1.0.0/sync`;

export async function v1Client(
  url: string,
  sessionId: string | null = crypto.randomUUID(),
  maxObservedTimestamp?: bigint,
) {
  const ws = new WebSocket(url);
  const got: v1.ServerMessage[] = [];
  ws.onmessage = (m) => got.push(v1.parseServerMessage(String(m.data)));
  const closed = new Promise<CloseEvent>((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  const send = (m: v1.ClientMessage) => ws.send(v1.encodeClientMessage(m));
  if (sessionId !== null)
    send({
      type: "Connect",
      sessionId,
      connectionCount: 0,
      lastCloseReason: null,
      clientTs: 0,
      ...(maxObservedTimestamp === undefined ? {} : { maxObservedTimestamp }),
    });
  let querySet = 0;
  const modify = (modifications: (v1.AddQuery | v1.RemoveQuery)[]) =>
    send({ type: "ModifyQuerySet", baseVersion: querySet, newVersion: ++querySet, modifications });
  const mutate = (requestId: number, udfPath: string, args: Record<string, unknown> = {}) =>
    send({ type: "Mutation", requestId, udfPath, args: [args as v1.JSONValue] });
  const transitions = () => got.filter((m): m is v1.Transition => m.type === "Transition");
  const responses = () => got.filter((m): m is v1.MutationResponse => m.type === "MutationResponse");
  const until = async <T>(f: () => T | undefined | false) => {
    for (let i = 0; i < 400; i++) {
      const x = f();
      if (x) return x;
      await Bun.sleep(5);
    }
    throw new Error(`timed out; got ${JSON.stringify(got, (_, x) => (typeof x === "bigint" ? `${x}n` : x))}`);
  };
  /** The transition after the first `n` ones. */
  const transition = (n: number) => until(() => transitions()[n]);
  return { ws, got, closed, send, modify, mutate, transitions, responses, transition, until };
}

export const add = (queryId: number, udfPath: string, args: Record<string, unknown> = {}): v1.AddQuery => ({
  type: "Add",
  queryId,
  udfPath,
  args: [args as v1.JSONValue],
});

/** The values a transition sets, by query id. */
export const updated = (t: v1.Transition) =>
  Object.fromEntries(
    t.modifications.flatMap((m) => (m.type === "QueryUpdated" ? [[m.queryId, m.value]] : [])),
  ) as Record<number, unknown>;

/** The results (values or error messages) every transition sent for query `id`, in order. */
export const history = (ts: v1.Transition[], id: number) =>
  ts.flatMap((t) =>
    t.modifications.flatMap((m) =>
      m.queryId !== id
        ? []
        : m.type === "QueryUpdated"
          ? [m.value]
          : m.type === "QueryFailed"
            ? [`error: ${m.errorMessage}`]
            : [],
    ),
  );
