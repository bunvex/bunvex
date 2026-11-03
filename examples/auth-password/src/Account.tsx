import { useAuthActions } from "@bunvex/auth/react";
import { useMutation, useQuery } from "@bunvex/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api";

export function Account() {
  const user = useQuery(api.currentUser.loggedInUser);
  const { signOut } = useAuthActions();
  if (user === undefined) return <p>Loading…</p>;
  if (user === null) return null;
  return (
    <section>
      <p>
        Signed in as <strong>{user.username}</strong>, since {new Date(user.signedUpAt).toLocaleString()}.
      </p>
      <ChangePassword />
      <button type="button" onClick={() => void signOut()}>
        Sign out
      </button>
    </section>
  );
}

function ChangePassword() {
  const changePassword = useMutation(api.auth.changePassword);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [signOutOtherSessions, setSignOutOtherSessions] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const result = await changePassword({ currentPassword, newPassword, signOutOtherSessions });
        setStatus(result.success ? "Password changed." : `Not changed: ${result.userError.error}`);
        if (result.success) {
          setCurrentPassword("");
          setNewPassword("");
        }
      }}
    >
      <h2>Change your password</h2>
      <label>
        Current password
        <input
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        New password
        <input
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={signOutOtherSessions}
          onChange={(e) => setSignOutOtherSessions(e.target.checked)}
        />
        Sign out my other sessions
      </label>
      {status && <p role="status">{status}</p>}
      <button type="submit">Change password</button>
    </form>
  );
}
