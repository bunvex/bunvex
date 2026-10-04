// Who may sign tokens for this deployment: Clerk, through the JWT template named "bunvex" (its `aud`). The
// issuer is your Clerk instance's ("Frontend API URL"), in the deployment's CLERK_JWT_ISSUER_DOMAIN variable:
// `bunvex env set CLERK_JWT_ISSUER_DOMAIN https://<your-instance>.clerk.accounts.dev`.
export default {
  providers: [{ domain: process.env.CLERK_JWT_ISSUER_DOMAIN!, applicationID: "bunvex" }],
};
