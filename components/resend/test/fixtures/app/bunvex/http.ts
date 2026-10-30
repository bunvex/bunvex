// The webhook route, as the component's README mounts it: `RESEND_WEBHOOK_SECRET` is read from the deployment's
// environment when the module loads.
import { Resend } from "@bunvex/resend";
import { componentsGeneric, httpActionGeneric, httpRouter } from "@bunvex/server";

// biome-ignore lint/suspicious/noExplicitAny: the app's components are untyped here
const components = componentsGeneric() as any;
const resend = new Resend(components.resend);

const http = httpRouter();
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpActionGeneric((ctx, req) => resend.handleResendEventWebhook(ctx, req)),
});
export default http;
