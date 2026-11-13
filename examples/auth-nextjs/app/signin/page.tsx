"use client";

import {
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "@bunvex/auth/methods/username-password/react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../bunvex/_generated/api";

/** The message for a sign-in's or a sign-up's `userError`: the app words each code itself. */
function message(userError: { error: string; [detail: string]: unknown }): string {
  switch (userError.error) {
    case "USER_NOT_FOUND":
      return "No account has that username.";
    case "INVALID_CREDENTIALS":
      return "Wrong username or password.";
    case "USERNAME_TAKEN":
      return "That username is taken.";
    case "PASSWORD_TOO_SHORT":
      return `A password has at least ${userError.minimumLength} characters.`;
    case "PASSWORD_TOO_COMMON":
      return "That password is one of the most common ones: pick another.";
    case "RATE_LIMITED":
      return `Too many attempts: try again in ${Math.ceil(Number(userError.retryAfterMs) / 1000)} s.`;
    default:
      console.error(userError);
      return "Something went wrong. Try again.";
  }
}

// The method's usual hooks, as in a single-page app: under the Next.js provider their calls go through the sign-in
// route, which keeps the refresh token in its cookie.
export default function SignIn() {
  const { signIn, pending: signingIn } = useSignInWithUsernamePassword(api.auth);
  const { signUp, pending: signingUp } = useSignUpWithUsernamePassword(api.auth);
  const router = useRouter();
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = signingIn || signingUp;

  return (
    <main>
      <h1>{mode === "signIn" ? "Sign in" : "Sign up"}</h1>
      <form
        style={{ display: "grid", gap: 12, maxWidth: 320 }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const credentials = { username, password };
          const result = mode === "signIn" ? await signIn(credentials) : await signUp(credentials);
          if (result.status === "complete") router.push("/");
          else setError(message(result.userError));
        }}
      >
        <label>
          Username
          <input name="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <button type="submit" disabled={pending}>
          {mode === "signIn" ? "Sign in" : "Sign up"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      <p>
        <button type="button" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
          {mode === "signIn" ? "No account yet? Sign up" : "Have an account? Sign in"}
        </button>
      </p>
    </main>
  );
}
