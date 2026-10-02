// The contract suite's part for feature flags (UI-01 §28): the flags' shape and evaluation-relevant
// invariants whenever the source offers `listFlags`; the writes (create, edit, kill switch, archive, history)
// only when the suite's writes are on.
import { expect } from "bun:test";
import type { DashboardDataSource } from "../../data-source.ts";
import type { ContractExtensionPart } from "../contract-types.ts";
import { flagProblem } from "./logic.ts";
import type { FeatureFlag, FlagInput } from "./types.ts";

type Flags = Pick<
  DashboardDataSource,
  "listFlags" | "getFlagHistory" | "flagExposures" | "saveFlag" | "setFlagEnabled" | "archiveFlag"
>;

export function expectFlag(f: FeatureFlag) {
  expect(flagProblem(f)).toBeUndefined();
  expect(f.updatedAt >= f.createdAt).toBe(true);
  if (f.archived) expect(f.enabled).toBe(false);
}

export const flagsContract: ContractExtensionPart = {
  id: "flags",
  requires: ["listFlags"],
  describe: ({ make, test, writes }) => {
    test("feature flags: sorted by key, each valid; history newest first; exposures per variant", async () => {
      const src = (await make()) as Flags;
      if (typeof src.listFlags !== "function") return;
      const flags = await src.listFlags();
      expect(flags.map((f) => f.key)).toEqual(flags.map((f) => f.key).sort());
      for (const f of flags) expectFlag(f);
      const first = flags[0];
      if (!first) return;
      if (src.getFlagHistory) {
        const h = await src.getFlagHistory(first.key);
        expect(h.every((c, i) => i === 0 || c.time <= h[i - 1]!.time)).toBe(true);
      }
      if (src.flagExposures) {
        const end = Date.now();
        const ex = await src.flagExposures(first.key, { start: end - 3_600_000, end, numBuckets: 60 });
        expect(ex.map((e) => e.variant).sort()).toEqual(first.variants.map((v) => v.key).sort());
        expect(ex.every((e) => e.series.length === 60)).toBe(true);
      }
    });

    if (!writes) return;
    test("feature flags: create, edit, kill switch and archive, each in the history; invalid flags refused", async () => {
      const src = (await make()) as Flags;
      if (!src.listFlags || !src.saveFlag || !src.setFlagEnabled || !src.archiveFlag) return;
      const key = `contract-${Date.now().toString(36)}`;
      const input: FlagInput = {
        key,
        name: "Contract flag",
        type: "boolean",
        enabled: true,
        variants: [
          { key: "on", value: true },
          { key: "off", value: false },
        ],
        offVariant: "off",
        rules: [],
        fallthrough: {
          rollout: [
            { variant: "on", weight: 10 },
            { variant: "off", weight: 90 },
          ],
        },
      };
      await src.saveFlag(input);
      await expect(src.saveFlag({ ...input, offVariant: "nope" })).rejects.toMatchObject({ code: "invalid_request" });
      await src.saveFlag({ ...input, fallthrough: { variant: "on" } });
      await src.setFlagEnabled(key, false);
      let f = (await src.listFlags()).find((x) => x.key === key)!;
      expect(f.enabled).toBe(false);
      expect(f.fallthrough).toEqual({ variant: "on" });
      await src.archiveFlag(key, true);
      f = (await src.listFlags()).find((x) => x.key === key)!;
      expect(f.archived).toBe(true);
      if (src.getFlagHistory) {
        const actions = (await src.getFlagHistory(key)).map((c) => c.action);
        expect(actions).toEqual(["archived", "disabled", "updated", "created"]);
      }
    });
  },
};
