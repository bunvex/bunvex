// Convex Auth's two ways of sending through the component (STUDY-200 §1.15), with its arguments: the app's mutation
// calls `lib.sendEmail` directly (`notify`), or makes a handle to it and gives it to the sibling component `authEmail`,
// which calls it from inside itself (`sendViaSibling`). The returned id is the component's email id.
import { componentsGeneric, createFunctionHandle, mutationGeneric } from "@bunvex/server";
import { v } from "@bunvex/values";

// biome-ignore lint/suspicious/noExplicitAny: the app's components are untyped here
const components = componentsGeneric() as any;
const authOptions = (apiKey: string) => ({ apiKey, testMode: false, initialBackoffMs: 30000, retryAttempts: 5 });

export const notify = mutationGeneric({
  args: { to: v.string() },
  handler: (ctx, { to }) =>
    ctx.runMutation(components.resend.lib.sendEmail, {
      options: authOptions("re_auth"),
      from: "auth@example.com",
      to: [to],
      subject: "Security notice",
      text: "Someone signed in.",
    }),
});

export const sendViaSibling = mutationGeneric({
  args: { to: v.string() },
  handler: async (ctx, { to }) => {
    const sendEmailHandle = await createFunctionHandle(components.resend.lib.sendEmail);
    return ctx.runMutation(components.authEmail.lib.sendCode, {
      sendEmailHandle,
      apiKey: "re_auth",
      to,
      code: "123456",
    });
  },
});
