// Send an email to one of Resend's test addresses, then watch it go from waiting to sent, and what Resend reports
// back through the webhook: delivered, bounced, complained, opened.
import { useMutation, useQuery } from "@bunvex/react";
import { useState } from "react";
import { api } from "../bunvex/_generated/api.js";

const TEST_ADDRESSES = ["delivered@resend.dev", "bounced@resend.dev", "complained@resend.dev"];

export function App() {
  const emails = useQuery(api.emails.list, {});
  const send = useMutation(api.emails.send);
  const cancel = useMutation(api.emails.cancel);
  const [to, setTo] = useState(TEST_ADDRESSES[0]!);
  const [subject, setSubject] = useState("Hello from bunvex");
  const [error, setError] = useState<string>();
  return (
    <main>
      <h1>@bunvex/resend</h1>
      <p>
        Emails are queued and sent to Resend in batches, within its rate limit; the webhook reports what happened to
        each. Test mode accepts Resend's test addresses only.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(undefined);
          send({ to, subject, text: "Sent with @bunvex/resend." }).catch((err: Error) => setError(err.message));
        }}
      >
        <select value={to} onChange={(e) => setTo(e.target.value)} aria-label="To">
          {TEST_ADDRESSES.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
        <button type="submit">Send</button>
      </form>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>To</th>
            <th>Subject</th>
            <th>Status</th>
            <th>Webhook events</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(emails ?? []).map((e) => (
            <tr key={e.emailId}>
              <td>{e.to}</td>
              <td>{e.subject}</td>
              <td>
                <span className={`status ${e.status}`}>{e.status}</span>
                {e.errorMessage && <div className="error">{e.errorMessage}</div>}
              </td>
              <td>{e.events.join(", ")}</td>
              <td>
                {(e.status === "waiting" || e.status === "queued") && (
                  <button type="button" onClick={() => cancel({ emailId: e.emailId })}>
                    Cancel
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
