// An app whose `setupAuth` lifetimes are invalid (STUDY-208 §1.2): its push must fail with the check's message.
import { defineApp } from "@bunvex/server";
import auth from "../../../../src/component/bunvex.config.ts";

const app = defineApp();
app.use(auth);
export default app;
