import { useEffect, useState } from "react";
import { DEMO } from "../content.ts";

type Message = { id: string; who: string; text: string };
const [LEFT, RIGHT] = DEMO.people;
const KEEP = 6;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEED: Message[] = DEMO.seed.map((m, i) => ({ ...m, id: `seed-${i}` }));

/**
 * Two browser tabs of one chat. A message typed in either appears in both, while the mutation that wrote it
 * lights up. The first render is the seeded conversation on both sides (what the prerender holds); the loop
 * starts once mounted, and with reduced motion the script is shown at once instead.
 */
export function LiveDemo() {
  const [messages, setMessages] = useState<Message[]>(SEED);
  const [typing, setTyping] = useState<{ who: string; text: string } | null>(null);
  const [pushed, setPushed] = useState(false);

  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setMessages([...SEED, ...DEMO.script.map((m, i) => ({ ...m, id: `m-${i}` }))].slice(-KEEP));
      return;
    }
    let stopped = false;
    let sent = 0;
    (async () => {
      while (!stopped) {
        for (const m of DEMO.script) {
          for (let i = 1; i <= m.text.length && !stopped; i++) {
            setTyping({ who: m.who, text: m.text.slice(0, i) });
            await wait(38);
          }
          await wait(250);
          if (stopped) return;
          setTyping(null);
          setMessages((ms) => [...ms, { ...m, id: `m-${sent++}` }].slice(-KEEP));
          setPushed(true);
          await wait(1300);
          setPushed(false);
          await wait(500);
        }
        await wait(1500);
        setMessages(SEED);
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  return (
    <figure className="relative grid grid-cols-1 gap-3.5 sm:grid-cols-2" aria-label="Two browser tabs of the same chat">
      <span
        aria-hidden="true"
        className={`absolute -top-3 right-3 z-10 rounded-full bg-violet px-2.5 py-0.5 font-mono text-xs text-honey-ink transition-opacity ${pushed ? "opacity-100" : "opacity-0"}`}
      >
        pushed to 2 clients
      </span>
      {DEMO.people.map((me) => (
        <ChatWindow
          key={me}
          me={me}
          messages={messages}
          typing={typing?.who === me ? typing.text : ""}
          hideOnPhone={me === RIGHT}
        />
      ))}
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-surface sm:col-span-2">
        <WindowBar title="bunvex/messages.ts" />
        <pre className="m-0 p-4 font-mono text-[12.8px] leading-[1.65] whitespace-pre-wrap">
          <span className="tok-k">export const</span> <span className="tok-f">send</span> = mutation({"{"}
          {"\n"}
          {"  "}args: {"{"} body: v.string(), author: v.string() {"}"},{"\n"}
          <span className={`inline-block w-full transition-colors ${pushed ? "bg-honey/15" : ""}`}>
            {"  "}handler: (ctx, m) =&gt; ctx.db.<span className="tok-f">insert</span>(
            <span className="tok-s">"messages"</span>, m),
          </span>
          {"\n"}
          {"});"}
          {"\n"}
          <span className="tok-c">
            {"// every useQuery(api.messages.list) re-runs and updates. No sockets, no cache code."}
          </span>
        </pre>
      </div>
      <figcaption className="sr-only">
        {LEFT} and {RIGHT} each have the chat open; a message sent from either tab appears in both.
      </figcaption>
    </figure>
  );
}

function WindowBar({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-line px-2.5 py-2 font-mono text-[11.5px] text-dim">
      <span aria-hidden="true" className="size-2 rounded-full bg-line" />
      <span aria-hidden="true" className="size-2 rounded-full bg-line" />
      <span aria-hidden="true" className="size-2 rounded-full bg-line" />
      <span className="ml-1.5">{title}</span>
    </div>
  );
}

function ChatWindow({
  me,
  messages,
  typing,
  hideOnPhone,
}: {
  me: string;
  messages: Message[];
  typing: string;
  hideOnPhone: boolean;
}) {
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-xl border border-line bg-surface ${hideOnPhone ? "max-sm:hidden" : ""}`}
    >
      <WindowBar title={`localhost:5173 · ${me}`} />
      <ul className="m-0 flex h-[210px] list-none flex-col justify-end gap-1.5 overflow-hidden p-3 text-[13.5px]">
        {messages.map((m) => (
          <li
            key={m.id}
            className={`max-w-[92%] animate-[site-pop_.35s_ease] rounded-[9px] border px-2.5 py-1.5 ${
              m.who === me ? "self-end border-honey/35 bg-honey/15" : "border-line bg-band"
            }`}
          >
            <b className={`mr-1.5 font-semibold ${m.who === me ? "text-honey" : "text-violet"}`}>{m.who}</b>
            {m.text}
          </li>
        ))}
      </ul>
      <div className="min-h-9 overflow-hidden border-t border-line px-2.5 py-2 font-mono text-[13px] whitespace-nowrap text-soft">
        {typing}
        <span
          aria-hidden="true"
          className="inline-block h-3.5 w-[7px] translate-y-0.5 animate-[site-blink_1s_steps(1)_infinite] bg-honey"
        />
      </div>
    </div>
  );
}
