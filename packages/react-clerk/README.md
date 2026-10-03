# @bunvex/react-clerk

`BunvexProviderWithClerk` (STUDY-54), the counterpart of Convex's `convex/react-clerk`: the React client,
authenticated with Clerk. Pass the `useAuth` of the Clerk SDK you use (`@clerk/clerk-react`, `@clerk/react`,
`@clerk/nextjs`, `@clerk/clerk-expo`, …).

```tsx
import { BunvexReactClient } from "@bunvex/react";
import { BunvexProviderWithClerk } from "@bunvex/react-clerk";
import { ClerkProvider, useAuth } from "@clerk/clerk-react";

const client = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL);

export const App = () => (
  <ClerkProvider publishableKey="pk_…">
    <BunvexProviderWithClerk client={client} useAuth={useAuth}>
      {/* … */}
    </BunvexProviderWithClerk>
  </ClerkProvider>
);
```

In Clerk's dashboard, create a JWT template named **`bunvex`** (an app moving from Convex renames its `convex`
template), and list Clerk as a provider of the deployment. When the session token itself has `aud: "bunvex"`,
it is used as is.
