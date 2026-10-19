// A room's actions (AD-43 step 6, STUDY-166): send a test event, remove a member, close the room. Writes, each
// recorded in the audit log, each confirmed in a dialog first — with the counts the screen already loaded, no dry
// run — and refused (`unauthorized`) for a credential that may not write, which sees none of the controls and a
// "Read-only" note instead, as the Data screen's. What the server refuses is said in the dialog, which stays open;
// what was done is said in the panel. A removal or a close that finds nothing (the member left, the room closed
// meanwhile) is not an error: it is said so.
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@bunvex/ui/components/alert-dialog";
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { Textarea } from "@bunvex/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../context.tsx";
import { capabilitiesQuery } from "../data/queries.ts";
import { type RoomInfo, type RoomMember, toDataSourceError, type Value } from "../data-source.ts";
import { parseLiteral, UNSET } from "../database/literal.ts";
import { useRoomDefinitions } from "../functions/rooms.tsx";
import { formatCount } from "../screens/stats.ts";
import { ConfirmButton } from "../shell/confirm.tsx";
import { defaultValueFor } from "../validators.ts";

/** What a removed member's app has to do to be back (RoomLeft `removed` is not retried). */
export const BACK_ONLY_IF = "they'll be back only if their app opens the room again (e.g. a reload)";

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

/** Which actions the source offers and the credential may do; `readOnly`: offered, but this credential may not. */
export function useRoomActions() {
  const scope = useQueryScope();
  const { source } = scope;
  const { data: caps } = useQuery(capabilitiesQuery(scope));
  const offered = {
    broadcast: typeof source.broadcastRoomEvent === "function",
    remove: typeof source.removeRoomMember === "function",
    close: typeof source.closeRoom === "function",
  };
  const any = offered.broadcast || offered.remove || offered.close;
  const canWrite = caps !== undefined && !caps.readOnly && caps.operations.includes("writeData");
  return {
    broadcast: canWrite && offered.broadcast,
    remove: canWrite && offered.remove,
    close: canWrite && offered.close,
    readOnly: any && caps !== undefined && !canWrite,
  };
}

/** The note a credential that may not act sees where the actions would be. */
export function ReadOnlyNote() {
  return (
    <p className="text-xs text-muted-foreground" title="This credential cannot change the deployment">
      Read-only: this credential cannot send events to rooms, remove members or close rooms.
    </p>
  );
}

/** The data box's start: the payload validator's template, as JSON. */
export function eventTemplate(payload: Parameters<typeof defaultValueFor>[0] | null | undefined): string {
  const v = payload ? defaultValueFor(payload) : undefined;
  return JSON.stringify(v ?? {}, null, 2);
}

/** The data typed (JSON; the dashboard's value syntax is read too), or why it is none. */
export function parseEventData(text: string): { ok: true; data: Value } | { ok: false; error: string } {
  const r = parseLiteral(text.trim() === "" ? "null" : text);
  if (!r.ok) return { ok: false, error: `The data is not valid JSON: ${r.error} (at ${r.offset}).` };
  if (r.value === UNSET) return { ok: false, error: "The data is not valid JSON: undefined is not a value." };
  return { ok: true, data: r.value };
}

/** Send a test event: an event name (the room's declared ones suggested) and its data, sent from the server. */
export function SendEventButton({ room, onDone }: { room: RoomInfo; onDone: (message: string) => void }) {
  const { source } = useQueryScope();
  const def = useRoomDefinitions().find((d) => d.kind === "room" && d.name === room.name);
  const declared = def?.events ?? [];
  const templateOf = (name: string) => eventTemplate(declared.find((e) => e.name === name)?.payload);
  const first = declared[0]?.name ?? "";
  const [open, setOpen] = useState(false);
  const [event, setEvent] = useState(first);
  const [data, setData] = useState(() => templateOf(first));
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { event: useId(), data: useId(), list: useId(), error: useId() };

  const reset = () => {
    setEvent(first);
    setData(templateOf(first));
    setEdited(false);
    setError(undefined);
  };
  const send = async () => {
    const name = event.trim();
    if (name === "") return setError("Name the event to send.");
    const parsed = parseEventData(data);
    if (!parsed.ok) return setError(parsed.error);
    setBusy(true);
    setError(undefined);
    try {
      await source.broadcastRoomEvent!({ key: room.key }, name, parsed.data);
      setOpen(false);
      onDone(`Sent ${name} to ${plural(room.members, "member")}, from the server.`);
    } catch (e) {
      // the server's words: an undeclared event, data its validator refuses, over the size limit
      setError(toDataSourceError(e).message);
    }
    setBusy(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <Send aria-hidden="true" />
        Send test event
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send a test event to {room.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            It goes to its {plural(room.members, "member")} now, from the server, as{" "}
            <code className="font-mono">ctx.rooms.broadcast</code> would send it. Their apps handle it as a real one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <form
          className="flex flex-col gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={ids.event} className="flex flex-col gap-1">
            <span className="text-muted-foreground">Event</span>
            <Input
              id={ids.event}
              list={ids.list}
              className="font-mono"
              value={event}
              aria-describedby={error ? ids.error : undefined}
              onChange={(e) => {
                setEvent(e.target.value);
                if (!edited) setData(templateOf(e.target.value));
              }}
            />
            <datalist id={ids.list}>
              {declared.map((e) => (
                <option key={e.name} value={e.name} />
              ))}
            </datalist>
          </label>
          <label htmlFor={ids.data} className="flex flex-col gap-1">
            <span className="text-muted-foreground">Data (JSON)</span>
            <Textarea
              id={ids.data}
              className="min-h-28 font-mono text-xs"
              spellCheck={false}
              value={data}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? ids.error : undefined}
              onChange={(e) => {
                setData(e.target.value);
                setEdited(true);
              }}
            />
          </label>
          {error && (
            <p id={ids.error} role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Keep it</AlertDialogCancel>
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send event"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Remove one member: its connections (a scope user's tabs) end now. */
export function RemoveMemberButton(props: { room: RoomInfo; member: RoomMember; onDone: (message: string) => void }) {
  const { source } = useQueryScope();
  const { room, member } = props;
  const scopeKind = room.kind === "presence";
  const who = scopeKind ? (member.userId ?? member.memberId) : member.memberId;
  const conns = plural(member.connections, scopeKind ? "tab" : "connection");
  return (
    <ConfirmButton
      label="Remove"
      size="sm"
      variant="destructive-outline"
      title={`Remove ${who} from ${room.name}?`}
      description={
        <>
          {scopeKind ? "Their" : "Its"} {conns} {member.connections === 1 ? "ends" : "end"} now, and the others see{" "}
          {scopeKind ? "them" : "it"} leave. This is not a ban: {BACK_ONLY_IF}.
        </>
      }
      confirm="Remove"
      busy="Removing…"
      keep="Keep them"
      action={async () => {
        const removed = await source.removeRoomMember!({ key: room.key }, member.memberId);
        props.onDone(
          removed === null
            ? `${who} had already left.`
            : `Removed ${who}: ${plural(removed.connections, scopeKind ? "tab" : "connection")} ended.`,
        );
      }}
    />
  );
}

/** Close the room: every member removed. */
export function CloseRoomButton(props: { room: RoomInfo; onDone: (message: string, closed: boolean) => void }) {
  const { room, onDone } = props;
  const { source } = useQueryScope();
  const scopeKind = room.kind === "presence";
  const members = plural(room.members, scopeKind ? "user" : "member");
  return (
    <ConfirmButton
      label={scopeKind ? "Close scope" : "Close room"}
      size="sm"
      variant="destructive-outline"
      title={`Close ${room.name}?`}
      description={
        <>
          Its {members} and their {plural(room.connections, "connection")} end now, and the{" "}
          {scopeKind ? "scope" : "room"} closes. This is not a ban: {BACK_ONLY_IF}.
        </>
      }
      confirm={scopeKind ? "Close scope" : "Close room"}
      busy="Closing…"
      keep="Keep it open"
      action={async () => {
        const closed = await source.closeRoom!({ key: room.key });
        onDone(
          closed === null
            ? "It had already closed."
            : `Closed it: ${plural(closed.members, scopeKind ? "user" : "member")} and ${plural(closed.connections, "connection")} ended.`,
          closed !== null,
        );
      }}
    />
  );
}
