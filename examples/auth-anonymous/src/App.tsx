import { useSignInAnonymously } from "@bunvex/auth/methods/anonymous/react";
import { useAuthActions } from "@bunvex/auth/react";
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from "@bunvex/react";
import { api } from "../bunvex/_generated/api";

export function App() {
  return (
    <main>
      <h1>Anonymous sign-in</h1>
      <AuthLoading>
        <p>Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <SignIn />
      </Unauthenticated>
      <Authenticated>
        <Visitor />
      </Authenticated>
    </main>
  );
}

function SignIn() {
  const { signIn } = useSignInAnonymously(api.auth);
  return (
    <>
      <p>You are signed out.</p>
      <button type="button" onClick={() => void signIn()}>
        Sign in anonymously
      </button>
    </>
  );
}

function Visitor() {
  const me = useQuery(api.users.me);
  const visit = useMutation(api.users.visit);
  const { signOut } = useAuthActions();
  return (
    <>
      <p>
        You are signed in as a new anonymous user{me ? `, with ${me.visits} visit${me.visits === 1 ? "" : "s"}` : ""}.
        Signing out ends this user: the next sign-in is someone else.
      </p>
      <button type="button" onClick={() => void visit()}>
        Count a visit
      </button>
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </>
  );
}
