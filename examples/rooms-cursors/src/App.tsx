import { usePresence, useRoom } from "@bunvex/react";
import { useEffect, useState } from "react";
import { api } from "../bunvex/_generated/api";

const BOARD = "main";

export function App() {
  // A name for this tab: a room needs no sign-in.
  const [name] = useState(() => `guest-${Math.floor(Math.random() * 100000)}`);
  return (
    <main>
      <h1>Cursors</h1>
      <p>
        You are <b data-testid="me">{name}</b>. Move the pointer over the board, and open this page in a second window.
      </p>
      <Online name={name} />
      <Board name={name} />
    </main>
  );
}

/** Who is online: a presence scope lists signed-in users, one per user whatever their tabs. */
function Online({ name }: { name: string }) {
  const { status, error, others, count, setMyState } = usePresence(api.rooms.online, { board: BOARD });
  useEffect(() => {
    if (status === "joined") setMyState({ name });
  }, [status, name, setMyState]);
  if (error) return <p data-testid="online">Who is online: {error.message}</p>;
  return (
    <p data-testid="online">
      {count} online
      {others.map((o) => (
        <span key={o.userId}> {o.state?.name ?? o.userId}</span>
      ))}
    </p>
  );
}

/** The room: everyone's cursor, and a wave. */
function Board({ name }: { name: string }) {
  const room = useRoom(api.rooms.board, { board: BOARD });
  const others = room.useOthers();
  const [, setMine] = room.useMyPresence();
  const wave = room.useBroadcast("wave");
  const [waves, setWaves] = useState<string[]>([]);
  room.useEvent("wave", (_from, data) => setWaves((w) => [...w.slice(-4), `${data.name} waves`]));

  return (
    <>
      <p data-testid="status">
        {room.status === "error"
          ? `Could not join: ${room.error?.message}`
          : `${room.status}, ${others.length} other(s)`}
      </p>
      <div
        data-testid="board"
        style={{ position: "relative", height: 320, border: "1px solid #888", overflow: "hidden" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMine({ x: Math.round(e.clientX - r.left), y: Math.round(e.clientY - r.top), name });
        }}
      >
        {others.map(
          (m) =>
            m.presence && (
              <span
                key={m.memberId}
                data-testid="cursor"
                data-name={m.presence.name}
                style={{ position: "absolute", left: m.presence.x, top: m.presence.y, pointerEvents: "none" }}
              >
                ➤ {m.presence.name}
              </span>
            ),
        )}
      </div>
      <button type="button" onClick={() => wave({ name })}>
        Wave
      </button>
      <ul data-testid="waves">
        {waves.map((w, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a short log of strings, appended to
          <li key={i}>{w}</li>
        ))}
      </ul>
    </>
  );
}
