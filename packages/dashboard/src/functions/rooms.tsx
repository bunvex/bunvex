// The deploy's room and presence definitions on the Functions screen (AD-43, STUDY-165 §5.1) — a bunvex addition:
// Convex has no rooms. Listed under the function tree, apart from it (the tree stays Convex's, built from the
// functions alone), and opened as `?room=<name>`: the kind and module, the args validator, the presence (a room's)
// or state (a scope's) validator, and the events with their payloads. Read with the function list, under its key,
// so a push heard by `watchFunctions` lists them again. A deployment without rooms answers `not_found`: no list.
import { useQuery } from "@tanstack/react-query";
import { Radio, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { useQueryScope } from "../context.tsx";
import { dashboardKeys, type QueryScope } from "../data/queries.ts";
import type { RoomDefinition, ValidatorJson } from "../data-source.ts";
import { KIND_LABEL } from "../rooms/words.ts";
import { DashLink } from "../router.tsx";
import { BAR1 } from "../shell/bars.ts";
import { displayValidator } from "../validators.ts";

const roomDefinitionsQuery = ({ source, scope }: QueryScope) => ({
  queryKey: [...dashboardKeys.functions(scope), "rooms"] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => source.listRoomDefinitions!({ signal }),
  enabled: typeof source.listRoomDefinitions === "function",
  // a deployment without rooms answers `not_found` each time: no need to ask again
  retry: false,
});

/** The deploy's room and presence definitions; none for a source or a deployment without rooms. */
export function useRoomDefinitions(): RoomDefinition[] {
  const { data } = useQuery(roomDefinitionsQuery(useQueryScope()));
  return data ?? [];
}

/** The definitions whose name has `query` in it (any case), as the tree's search matches a function's path. */
export const matchDefinitions = (defs: readonly RoomDefinition[], query: string) => {
  const q = query.trim().toLowerCase();
  return q === "" ? [...defs] : defs.filter((d) => d.name.toLowerCase().includes(q));
};

/** The sidebar's list under the tree: its own heading, its own links (`className` is the tree's link style). */
export function RoomDefinitionsList(props: {
  definitions: readonly RoomDefinition[];
  current?: string;
  className: string;
}) {
  if (props.definitions.length === 0) return null;
  return (
    <nav aria-labelledby="room-definitions" className="max-h-48 shrink-0 overflow-y-auto border-t py-2 lg:max-h-[40%]">
      <h2 id="room-definitions" className="px-3 py-1 text-xs font-medium text-muted-foreground">
        Rooms and presence
      </h2>
      <ul>
        {props.definitions.map((d) => {
          const Icon = d.kind === "room" ? Radio : UsersRound;
          return (
            <li key={d.name}>
              <DashLink
                link={{ to: "/functions", search: { room: d.name } }}
                className={props.className}
                style={{ paddingLeft: "0.75rem" }}
                aria-current={d.name === props.current ? "page" : undefined}
              >
                <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.name}</span>
                <span className="sr-only">, {KIND_LABEL[d.kind].toLowerCase()}</span>
              </DashLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** A definition, open: what it is, where it lives, its validators and events. */
export function RoomDefinitionView(props: { def: RoomDefinition; ValidatorCode: (p: { code: string }) => ReactNode }) {
  const { def, ValidatorCode } = props;
  const room = def.kind === "room";
  const shown: { title: string; v: ValidatorJson | null | undefined; none: string }[] = [
    { title: "Arguments", v: def.args, none: "None: it takes no arguments." },
    room
      ? { title: "Presence", v: def.presence, none: "None declared: any presence is accepted." }
      : { title: "State", v: def.state, none: "None declared: any state is accepted." },
  ];
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={BAR1}>
        <h1 className="font-mono text-base font-semibold tracking-tight">{def.name}</h1>
        <span className="text-sm text-muted-foreground">
          {KIND_LABEL[def.kind]} in <span className="font-mono text-xs">{def.module}</span>
        </span>
        <DashLink
          link={{ to: "/rooms", search: { name: def.name } }}
          className="ml-auto text-sm underline-offset-4 hover:underline"
        >
          Open {room ? "rooms" : "scopes"}
        </DashLink>
      </div>
      <div className="flex flex-col gap-6 p-4 md:p-6 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <div className="grid gap-3 md:grid-cols-2">
          {shown.map(({ title, v, none }) => (
            <section key={title} aria-label={`${title} validator`} className="min-w-0">
              <h2 className="mb-1 text-sm font-medium">{title}</h2>
              {v ? (
                <ValidatorCode code={displayValidator(v)} />
              ) : (
                <p className="text-sm text-muted-foreground">{none}</p>
              )}
            </section>
          ))}
        </div>
        <section aria-labelledby="room-events">
          <h2 id="room-events" className="mb-1 text-sm font-medium">
            Events
          </h2>
          {def.events.length === 0 ? (
            <p className="text-sm text-muted-foreground">None declared.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {def.events.map((e) => (
                <li key={e.name} aria-label={e.name} className="min-w-0">
                  <p className="mb-1 font-mono text-xs font-medium">{e.name}</p>
                  {e.payload ? (
                    <ValidatorCode code={displayValidator(e.payload)} />
                  ) : (
                    <p className="text-sm text-muted-foreground">Any payload.</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
