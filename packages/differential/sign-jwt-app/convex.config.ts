// The app of test/sign-jwt.test.ts (STUDY-192): one local component, `signer`, whose tokens carry its path.
import { defineApp } from "convex/server";
import signer from "./signer/convex.config";

const app = defineApp();
app.use(signer);
export default app;
