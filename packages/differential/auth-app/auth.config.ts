// The auth component's tokens, accepted as any custom JWT: the deployment verifies them against its own JWKS.
import { convexAuthProvider } from "@convex-dev/auth/server";

export default { providers: [convexAuthProvider()] };
