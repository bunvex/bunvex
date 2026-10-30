// The component's client (STUDY-200 §1.10), with the API of Convex's resend 0.2.10: the `Resend` class, which queues
// emails (or records ones the app sends itself), cancels them, reads their status, takes Resend's webhooks and defines
// the `onEmailEvent` callback; and the validators and types an app writes that callback with. Its defaults are
// Convex's: `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET` read when the class is built, a 30 s initial backoff, 5
// attempts, and test mode on.
//
// The webhook's Svix signature is checked with WebCrypto (DV-582, `webhook.ts`), with svix's messages.
import {
  createFunctionHandle,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
  type FunctionVisibility,
  type GenericDataModel,
  type GenericMutationCtx,
  internalMutationGeneric,
} from "@bunvex/server";
import { type VString, v } from "@bunvex/values";
import type { ComponentApi } from "../component/_generated/component.ts";
import {
  type ActionCtx,
  type EmailEvent,
  type MutationCtx,
  type QueryCtx,
  type RuntimeConfig,
  type Status,
  type Template,
  vEmailEvent,
} from "../component/shared.ts";
import { verifyWebhook, webhookKey } from "./webhook.ts";

/** The component, as `components.resend` gives it. */
export type ResendComponent = ComponentApi;

/** An email's id in the component, as `sendEmail` returns it. */
export type EmailId = string & { __isEmailId: true };
/** An email's id: a string. */
export const vEmailId = v.string() as VString<EmailId>;
export type { EmailEvent, Status, Template } from "../component/shared.ts";
export { vEmailEvent, vOptions, vStatus, vTemplate } from "../component/shared.ts";
/** The arguments of an `onEmailEvent` mutation: the email's id and the event. */
export const vOnEmailEventArgs = v.object({ id: vEmailId, event: vEmailEvent });

type Config = RuntimeConfig & { webhookSecret: string };

/** The mutation an app gives as `onEmailEvent`. */
type OnEmailEvent = FunctionReference<"mutation", FunctionVisibility, { id: EmailId; event: EmailEvent }>;

/** A `Resend`'s options; each one left out takes its default. */
export type ResendOptions = {
  /** The Resend API key; by default the `RESEND_API_KEY` environment variable. */
  apiKey?: string;
  /** The secret Resend signs its webhooks with; by default the `RESEND_WEBHOOK_SECRET` environment variable. */
  webhookSecret?: string;
  /** How long the first retry of a failed batch call waits, in ms; 30 seconds by default. */
  initialBackoffMs?: number;
  /** How many times a batch call is tried in all before its emails fail; 5 by default. */
  retryAttempts?: number;
  /**
   * Whether only Resend's test addresses may be sent to (`delivered@resend.dev`, `bounced@…`, `complained@…`, with an
   * optional `+label`). On by default: set it to `false` to send to anyone.
   */
  testMode?: boolean;
  /** A mutation run after each event Resend reports about an email, with the email's id and the event. */
  onEmailEvent?: OnEmailEvent | null;
};

/** An email's status, as `status` returns it. */
export type EmailStatus = {
  /**
   * Where the email is:
   * - `waiting`: not in a batch yet;
   * - `queued`: in a batch, waiting to be sent;
   * - `cancelled`: cancelled;
   * - `sent`: sent to Resend, its fate not known yet;
   * - `bounced`: bounced;
   * - `delivered`: delivered;
   * - `delivery_delayed`: Resend is having trouble delivering it, and still tries;
   * - `failed`: it could not be sent.
   */
  status: Status;
  /** Why it failed or bounced; null otherwise. */
  errorMessage: string | null;
  /** Whether it bounced. */
  bounced: boolean;
  /** Whether its recipient marked it as spam. */
  complained: boolean;
  /** Whether it failed. */
  failed: boolean;
  /** Whether its delivery was delayed. */
  deliveryDelayed: boolean;
  /** Whether Resend saw it opened (with open tracking). */
  opened: boolean;
  /** Whether Resend saw a link in it clicked (with click tracking). */
  clicked: boolean;
};

type Header = { name: string; value: string };
type Recipients = {
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string[];
  headers?: Header[];
  /**
   * A key that dedupes sends: when an email was already queued with it, `sendEmail` returns that email's
   * {@link EmailId} and queues nothing.
   */
  idempotencyKey?: string;
};

/** What `sendEmail` sends: a subject with an HTML and/or text body, or a Resend template. */
export type SendEmailOptions =
  | (Recipients & { subject: string; html?: string; text?: string })
  | (Recipients & { subject?: string; template: Template; html?: never; text?: never });

/** An email, as `get` returns it. */
type Email = {
  from: string;
  to: string[];
  subject?: string;
  replyTo: string[];
  headers?: Header[];
  status: Status;
  errorMessage?: string;
  bounced?: boolean;
  complained: boolean;
  failed?: boolean;
  deliveryDelayed?: boolean;
  opened?: boolean;
  clicked?: boolean;
  resendId?: string;
  finalizedAt: number;
  createdAt: number;
  html?: string;
  text?: string;
  template?: Template;
};

/** The calls the client makes on a context, by reference (a union of contexts cannot call an overloaded method). */
type Runner = {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    mutation: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
  runQuery<Q extends FunctionReference<"query", "internal">>(
    query: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;
};
const runner = (ctx: QueryCtx | MutationCtx | ActionCtx) => ctx as unknown as Runner;

const asArray = (value: string | string[] | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

export class Resend {
  public config: Config;
  onEmailEvent?: OnEmailEvent | null;

  /**
   * A client of the component.
   *
   * @param component The mounted component, like `components.resend` from `./_generated/api`.
   * @param options Its {@link ResendOptions}.
   */
  constructor(
    public component: ResendComponent,
    options?: ResendOptions,
  ) {
    this.config = {
      apiKey: options?.apiKey ?? process.env.RESEND_API_KEY ?? "",
      webhookSecret: options?.webhookSecret ?? process.env.RESEND_WEBHOOK_SECRET ?? "",
      initialBackoffMs: options?.initialBackoffMs ?? 30000,
      retryAttempts: options?.retryAttempts ?? 5,
      testMode: options?.testMode ?? true,
    };
    if (options?.onEmailEvent) this.onEmailEvent = options.onEmailEvent;
  }

  /**
   * Queue an email. It goes out with others in a batch call to Resend, durably, retried and rate limited; Resend
   * sees each batch once, by its idempotency key.
   *
   * @param ctx A mutation's or an action's context.
   * @param options The email: {@link SendEmailOptions}.
   * @returns The email's id in the component.
   */
  async sendEmail(ctx: MutationCtx | ActionCtx, options: SendEmailOptions): Promise<EmailId>;
  /**
   * Queue an email, given as separate arguments.
   *
   * @param ctx A mutation's or an action's context.
   * @param from The sender.
   * @param to The recipient.
   * @param subject The subject.
   * @param html The HTML body.
   * @param text The text body.
   * @param replyTo Reply-to addresses.
   * @param headers Extra headers.
   * @returns The email's id in the component.
   */
  async sendEmail(
    ctx: MutationCtx | ActionCtx,
    from: string,
    to: string,
    subject: string,
    html?: string,
    text?: string,
    replyTo?: string[],
    headers?: Header[],
  ): Promise<EmailId>;
  /** @deprecated Use the object form, `{ from, to, subject, html }`. */
  async sendEmail(
    ctx: MutationCtx | ActionCtx,
    fromOrOptions: string | SendEmailOptions,
    to?: string,
    subject?: string,
    html?: string,
    text?: string,
    replyTo?: string[],
    headers?: Header[],
  ): Promise<EmailId> {
    const email: SendEmailOptions =
      typeof fromOrOptions === "string"
        ? { from: fromOrOptions, to: to as string, subject: subject as string, html, text, replyTo, headers }
        : fromOrOptions;
    if (this.config.apiKey === "") throw new Error("API key is not set");
    // Any other key of `email` is passed on, and refused by the component's validator.
    const id = await runner(ctx).runMutation(this.component.lib.sendEmail, {
      options: await this.runtimeOptions(),
      ...email,
      to: typeof email.to === "string" ? [email.to] : email.to,
      cc: asArray(email.cc),
      bcc: asArray(email.bcc),
    } as FunctionArgs<ResendComponent["lib"]["sendEmail"]>);
    return id as EmailId;
  }

  /** The options sent with each email; the callback's handle is made at each call. */
  private async runtimeOptions(): Promise<RuntimeConfig> {
    return {
      apiKey: this.config.apiKey,
      initialBackoffMs: this.config.initialBackoffMs,
      retryAttempts: this.config.retryAttempts,
      testMode: this.config.testMode,
      onEmailEvent: this.onEmailEvent ? { fnHandle: await createFunctionHandle(this.onEmailEvent) } : undefined,
    };
  }

  /**
   * Send an email yourself (with attachments, say) and keep its record here: the email is recorded as `queued`,
   * `sendCallback` sends it and returns Resend's id, and the email becomes `sent`, or `failed` with the error when the
   * callback throws (rethrown). Its webhooks then apply as for any email.
   *
   * @param ctx A mutation's or an action's context.
   * @param options The email's addresses, subject and headers.
   * @param sendCallback Sends the email, given its id here (an idempotency key), and returns Resend's id.
   * @returns The email's id in the component.
   */
  async sendEmailManually(
    ctx: MutationCtx | ActionCtx,
    options: {
      from: string;
      to: string | string[];
      cc?: string | string[];
      bcc?: string | string[];
      subject: string;
      replyTo?: string[];
      headers?: Header[];
    },
    sendCallback: (emailId: EmailId) => Promise<string>,
  ): Promise<EmailId> {
    const run = runner(ctx);
    const emailId = (await run.runMutation(this.component.lib.createManualEmail, {
      from: options.from,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      replyTo: options.replyTo,
      headers: options.headers,
    })) as EmailId;
    try {
      const resendId = await sendCallback(emailId);
      await run.runMutation(this.component.lib.updateManualEmail, { emailId, status: "sent", resendId });
    } catch (error) {
      const carried = typeof error === "object" && error !== null && "resendId" in error ? error.resendId : undefined;
      await run.runMutation(this.component.lib.updateManualEmail, {
        emailId,
        status: "failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        resendId: typeof carried === "string" ? carried : undefined,
      });
      throw error;
    }
    return emailId;
  }

  /**
   * Cancel an email not sent to Resend yet. Throws if it was.
   *
   * @param ctx A mutation's or an action's context.
   * @param emailId The id `sendEmail` returned.
   */
  async cancelEmail(ctx: MutationCtx | ActionCtx, emailId: EmailId): Promise<void> {
    await runner(ctx).runMutation(this.component.lib.cancelEmail, { emailId });
  }

  /**
   * An email's status.
   *
   * @param ctx A query's, a mutation's or an action's context.
   * @param emailId The id `sendEmail` returned.
   * @returns Its {@link EmailStatus}, or null when there is no such email.
   */
  async status(ctx: QueryCtx | MutationCtx | ActionCtx, emailId: EmailId): Promise<EmailStatus | null> {
    return await runner(ctx).runQuery(this.component.lib.getStatus, { emailId });
  }

  /**
   * A whole email, its bodies included.
   *
   * @param ctx A query's, a mutation's or an action's context.
   * @param emailId The id `sendEmail` returned.
   * @returns The email, or null when there is no such email.
   */
  async get(ctx: QueryCtx | MutationCtx | ActionCtx, emailId: EmailId): Promise<Email | null> {
    return await runner(ctx).runQuery(this.component.lib.get, { emailId });
  }

  /**
   * Take a Resend webhook: check its signature against the webhook secret, apply the event to its email and run
   * `onEmailEvent`. Mount it on an HTTP route Resend posts to:
   * ```ts
   * http.route({
   *   path: "/resend-webhook",
   *   method: "POST",
   *   handler: httpAction((ctx, req) => resend.handleResendEventWebhook(ctx, req)),
   * });
   * ```
   *
   * @param ctx An HTTP action's (or any) context that can run a mutation.
   * @param req The request from Resend.
   * @returns A 201 with no body. A missing secret or a refused signature throws.
   */
  async handleResendEventWebhook(ctx: MutationCtx | ActionCtx, req: Request): Promise<Response> {
    if (this.config.webhookSecret === "") throw new Error("Webhook secret is not set");
    const key = webhookKey(this.config.webhookSecret);
    const body = await req.text();
    const event = await verifyWebhook(key, body, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    });
    await runner(ctx).runMutation(this.component.lib.handleEmailEvent, { event });
    return new Response(null, { status: 201 });
  }

  /**
   * Define the mutation to run after each email event, to pass as `onEmailEvent`. An `internalMutation` with
   * `vOnEmailEventArgs` as its `args` does the same.
   *
   * @param handler Runs with the email's id and the event.
   */
  defineOnEmailEvent<DataModel extends GenericDataModel>(
    handler: (ctx: GenericMutationCtx<DataModel>, args: { id: EmailId; event: EmailEvent }) => Promise<void>,
  ) {
    return internalMutationGeneric({ args: { id: vEmailId, event: vEmailEvent }, handler });
  }
}
