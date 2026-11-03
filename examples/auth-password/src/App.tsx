import { Authenticated, AuthLoading, Unauthenticated } from "@bunvex/react";
import { Account } from "./Account.tsx";
import { SignIn } from "./SignIn.tsx";

export function App() {
  return (
    <main>
      <h1>Username and password</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Account />
      </Authenticated>
    </main>
  );
}
