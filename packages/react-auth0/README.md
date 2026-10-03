# @bunvex/react-auth0

`BunvexProviderWithAuth0` (STUDY-47), the counterpart of Convex's `convex/react-auth0`: the React client,
authenticated with Auth0. It must be under `Auth0Provider` (`@auth0/auth0-react`, a peer dependency).

```tsx
import { Auth0Provider } from "@auth0/auth0-react";
import { BunvexReactClient } from "@bunvex/react";
import { BunvexProviderWithAuth0 } from "@bunvex/react-auth0";

const client = new BunvexReactClient(import.meta.env.VITE_BUNVEX_URL);

export const App = () => (
  <Auth0Provider domain="your-tenant.auth0.com" clientId="…" authorizationParams={{ redirect_uri: location.origin }}>
    <BunvexProviderWithAuth0 client={client}>{/* … */}</BunvexProviderWithAuth0>
  </Auth0Provider>
);
```

The token sent is Auth0's ID token, so the deployment lists the Auth0 domain with the client id as its
application id.
