import {
  useSignInWithUsernamePassword,
  useSignUpWithUsernamePassword,
} from "@bunvex/auth/methods/username-password/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api";

/** The message for a sign-in's or a sign-up's `userError`: the app words each code itself. */
function message(userError: { error: string; [detail: string]: unknown }): string {
  switch (userError.error) {
    case "USER_NOT_FOUND":
      return "No account has that username.";
    case "INVALID_CREDENTIALS":
      return "Wrong username or password.";
    case "USERNAME_TAKEN":
      return "That username is taken.";
    case "USERNAME_TOO_SHORT":
      return "Pick a username.";
    case "USERNAME_HAS_SURROUNDING_WHITESPACE":
      return "A username can't start or end with a space.";
    case "USERNAME_HAS_INVALID_CHARACTERS":
      return "That username has characters it can't have.";
    case "PASSWORD_TOO_SHORT":
      return `A password has at least ${userError.minimumLength} characters.`;
    case "PASSWORD_TOO_LONG":
      return `A password has at most ${userError.maximumLength} characters.`;
    case "PASSWORD_HAS_SURROUNDING_WHITESPACE":
      return "A password can't start or end with a space.";
    case "PASSWORD_TOO_COMMON":
      return "That password is one of the most common ones: pick another.";
    case "RATE_LIMITED":
      return `Too many attempts: try again in ${Math.ceil(Number(userError.retryAfterMs) / 1000)} s.`;
    default:
      // OTHER_ERROR: the call itself failed (its error is on `cause`).
      console.error(userError);
      return "Something went wrong. Try again.";
  }
}

export function SignIn() {
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const { signIn, pending: signingIn } = useSignInWithUsernamePassword(api.auth);
  const { signUp, pending: signingUp } = useSignUpWithUsernamePassword(api.auth);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const pending = signingIn || signingUp;

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const credentials = { username, password };
        const result = mode === "signIn" ? await signIn(credentials) : await signUp(credentials);
        // Complete: the provider keeps the session, and <Authenticated> shows the account.
        if (result.status === "error") setError(message(result.userError));
      }}
    >
      <h2>{mode === "signIn" ? "Sign in" : "Sign up"}</h2>
      <label>
        Username
        <input
          name="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          required
          disabled={pending}
        />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signIn" ? "current-password" : "new-password"}
          required
          disabled={pending}
        />
      </label>
      {mode === "signUp" && <p className="hint">At least 10 characters, and not one of the most common passwords.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={pending}>
        {mode === "signIn" ? "Sign in" : "Sign up"}
      </button>
      <button type="button" className="link" onClick={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
        {mode === "signIn" ? "No account yet? Sign up" : "Have an account? Sign in"}
      </button>
    </form>
  );
}
