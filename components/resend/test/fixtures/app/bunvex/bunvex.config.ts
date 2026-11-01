// An app that installs the component as a user's app does: by the package's name and its `./bunvex.config.js` export,
// mounted twice (`resend` and `customResend`, as upstream's client test does), its children coming with it. Beside it,
// `authEmail`, a sibling component that sends through `resend` by a handle the app gives it, as Convex Auth's email
// component does (STUDY-200 §1.15).
import resend from "@bunvex/resend/bunvex.config.js";
import { defineApp } from "@bunvex/server";
import authEmail from "../../authEmail/bunvex.config.ts";

const app = defineApp();
app.use(resend);
app.use(resend, { name: "customResend" });
app.use(authEmail);
export default app;
