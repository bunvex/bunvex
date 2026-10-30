// Resend's webhook: point it at `<your site URL>/resend-webhook` in Resend's dashboard, with the signing secret as
// `RESEND_WEBHOOK_SECRET`. The component checks the signature and updates the email's status.
import { httpRouter } from "@bunvex/server";
import { httpAction } from "./_generated/server.js";
import { resend } from "./emails.js";

const http = httpRouter();
http.route({
  path: "/resend-webhook",
  method: "POST",
  handler: httpAction(async (ctx, req) => resend.handleResendEventWebhook(ctx, req)),
});
export default http;
