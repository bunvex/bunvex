// The mock's part of each extension (UI-01 §26): `MockDataSource` gives every part a context and adds the
// methods it returns. To remove an extension: delete its line here (and its folder, `index.ts`, `contract.ts`).
import { analyticsMock } from "./analytics/mock-part.ts";
import { flagsMock } from "./flags/mock.ts";
import type { MockExtensionPart } from "./mock-types.ts";

export const mockParts: readonly MockExtensionPart[] = [analyticsMock, flagsMock];
