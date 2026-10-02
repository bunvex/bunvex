// Settings → Map style (STUDY-12 §16, UI-01 §26.2): the Realtime map's basemap. The default is the bundled,
// offline one; a MapLibre style URL gives a richer map, after a check that it answers with a style, and with a
// warning that it contacts a third party. Kept in this browser per deployment. Added by the Analytics extension.
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import { useQueryScope } from "../../context.tsx";
import { SettingsLayout } from "../../settings/layout.tsx";
import { isMapLibreStyle, mapStyleProblem, readMapStyle, writeMapStyle } from "./map-style.ts";

export function MapStyleSettingsScreen() {
  const { scope } = useQueryScope();
  const [saved, setSaved] = useState(() => readMapStyle(scope));
  const [text, setText] = useState(saved ?? "");
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string }>();
  const [busy, setBusy] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const problem = text.trim() ? mapStyleProblem(text) : undefined;

  const use = async () => {
    const url = text.trim();
    setBusy(true);
    setOutcome(undefined);
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`it answered ${res.status}`);
      if (!isMapLibreStyle(await res.json()))
        throw new Error("it is not a MapLibre style (version 8, sources, layers)");
      writeMapStyle(scope, url);
      setSaved(url);
      setOutcome({ ok: true, message: "The Realtime map now uses this style." });
    } catch (e) {
      setOutcome({ ok: false, message: `Not used: ${e instanceof Error ? e.message : String(e)}.` });
    }
    setBusy(false);
  };

  return (
    <SettingsLayout title="Map style" description="The basemap of Analytics → Realtime">
      <div className="flex max-w-2xl flex-col gap-5 text-sm">
        <p>
          {saved ? (
            <>
              The Realtime map uses the style at <code className="font-mono text-xs break-all">{saved}</code>.
            </>
          ) : (
            <>
              The Realtime map uses the <strong className="font-medium">built-in basemap</strong>: country outlines
              bundled with the dashboard, so it works offline and asks nothing of anyone else.
            </>
          )}
        </p>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void use();
          }}
        >
          <label htmlFor={inputId} className="font-medium">
            MapLibre style URL
          </label>
          <Input
            id={inputId}
            type="url"
            placeholder="https://tiles.example.com/styles/dark/style.json"
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={hintId}
            onChange={(e) => {
              setText(e.target.value);
              setOutcome(undefined);
            }}
          />
          <p id={hintId} className={problem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            {problem ?? "A style.json for MapLibre GL. It is fetched once to check it before it is used."}
          </p>
          <div
            role="note"
            className="flex items-start gap-2 border border-warning/40 bg-warning/10 p-3 text-xs text-foreground"
          >
            <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              A style URL makes the map load tiles, fonts and icons from that provider. Each viewer's browser contacts
              it, and the map stops working offline. The choice is kept in this browser only.
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || !text.trim() || !!problem || text.trim() === saved}>
              {busy ? "Checking…" : "Use this style"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!saved}
              onClick={() => {
                writeMapStyle(scope, null);
                setSaved(null);
                setText("");
                setOutcome({ ok: true, message: "The Realtime map uses the built-in basemap again." });
              }}
            >
              Use the built-in basemap
            </Button>
          </div>
          <p
            role={outcome && !outcome.ok ? "alert" : "status"}
            className={outcome?.ok === false ? "text-destructive" : "text-muted-foreground"}
          >
            {outcome?.message}
          </p>
        </form>
      </div>
    </SettingsLayout>
  );
}
