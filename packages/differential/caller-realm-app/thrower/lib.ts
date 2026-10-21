// The component of test/caller-realm.test.ts: a query and a mutation that throw.
import { mutationGeneric, queryGeneric } from "convex/server";
import { ConvexError } from "convex/values";

const fail = (data: boolean) => {
  if (data) throw new ConvexError({ code: "COMPONENT", n: 7 });
  throw new Error("component boom");
};

export const boomQuery = queryGeneric(async (_ctx, { data }: { data: boolean }) => fail(data));
export const boomMutation = mutationGeneric(async (_ctx, { data }: { data: boolean }) => fail(data));
