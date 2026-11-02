// An app with the core mounted, for `setupAuth`'s helpers (upstream's `server/setup.test.ts` harness): `testApp` binds a
// test method whose mutations expose each helper.
import { defineApp } from "@bunvex/server";
import auth from "../../../../src/component/bunvex.config.ts";

const app = defineApp();
app.use(auth);
export default app;
