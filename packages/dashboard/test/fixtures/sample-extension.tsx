// A sample extension, for the registry's tests only (UI-01 §26): one screen that lists "samples" through an
// optional contract method, a mock part that implements it, and a contract part.
import { expect } from "bun:test";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical } from "lucide-react";
import { useQueryScope } from "../../src/context.tsx";
import type { CallOptions } from "../../src/data-source.ts";
import type { ContractExtensionPart } from "../../src/extensions/contract-types.ts";
import type { MockExtensionPart } from "../../src/extensions/mock-types.ts";
import { type DashboardExtension, offers } from "../../src/extensions/types.ts";

type SampleSource = { listSamples?(opts?: CallOptions): Promise<string[]> };

export const sampleExtension: DashboardExtension = {
  id: "sample",
  title: "Samples",
  icon: FlaskConical,
  nav: { group: "extensions", order: 1, to: "/samples" },
  routes: [{ path: "samples", load: () => import("./sample-extension.tsx"), component: "SamplesScreen" }],
  requires: ["listSamples" as never],
};

export function SamplesScreen() {
  const { source, scope } = useQueryScope();
  const { data = [] } = useQuery({
    queryKey: ["bunvex", scope, "samples"],
    queryFn: () => (source as SampleSource).listSamples!(),
  });
  return (
    <>
      <h1 className="text-xl font-semibold">Samples</h1>
      <ul aria-label="Samples">
        {data.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
    </>
  );
}

export const sampleMock: MockExtensionPart = {
  id: "sample",
  create: (ctx) => ({
    listSamples: (opts?: CallOptions) =>
      ctx.call(opts?.signal, () => {
        ctx.record("list_samples", {});
        return [`sample at ${ctx.now()}`, `seeded ${ctx.rnd.int(1, 9) > 0}`];
      }),
  }),
};

export const sampleContract: ContractExtensionPart = {
  id: "sample",
  requires: ["listSamples" as never],
  describe: ({ make, test }) =>
    test("sample extension: listSamples returns strings", async () => {
      const src = await make();
      if (!offers(src, { requires: ["listSamples" as never] })) return;
      const list = await (src as SampleSource).listSamples!();
      expect(list.every((s) => typeof s === "string")).toBe(true);
    }),
};
