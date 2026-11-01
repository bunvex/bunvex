// Resend's webhook, as the package's README mounts it.
import { httpActionGeneric, httpRouter } from "convex/server";
import { resend } from "./emails";

const http = httpRouter();
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpActionGeneric(async (ctx, req) => resend.handleResendEventWebhook(ctx, req)),
});
export default http;
