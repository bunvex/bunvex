// The design system's page (UI-01 §17.5): @bunvex/ui's tokens and components, each shown in the light and
// the dark theme side by side, for whoever works on the dashboard's screens. A second page of this
// private dev host (/design-system.html), not of the public site: it is a tool, not documentation.
import { Badge } from "@bunvex/ui/components/badge";
import { Button } from "@bunvex/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@bunvex/ui/components/card";
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { CopyButton } from "@bunvex/ui/components/copy-button";
import { DataTable, dataTableColumns } from "@bunvex/ui/components/data-table";
import { Input } from "@bunvex/ui/components/input";
import { JsonView } from "@bunvex/ui/components/json-view";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { Sparkline } from "@bunvex/ui/components/sparkline";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { Textarea } from "@bunvex/ui/components/textarea";
import { ThemeToggle } from "@bunvex/ui/components/theme-toggle";
import { ThemeProvider } from "@bunvex/ui/theme";
import { createContext, type ReactNode, StrictMode, useContext } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

/** Which panel a specimen is in: ids get it as a suffix, so the two copies stay distinct. */
const Panel = createContext<"light" | "dark">("light");
const useId = (name: string) => `${name}-${useContext(Panel)}`;

/** The same children in a light and a dark panel. */
function Specimen({ title, children }: { title: string; children: ReactNode }) {
  const id = title.toLowerCase().replace(/[^a-z]+/g, "-");
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-base font-medium">
        {title}
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {(["light", "dark"] as const).map((theme) => (
          <Panel.Provider key={theme} value={theme}>
            <section
              aria-label={`${title}, ${theme}`}
              className={`${theme === "dark" ? "dark " : ""}flex min-w-0 flex-col gap-3 border bg-background p-4 text-foreground`}
            >
              {children}
            </section>
          </Panel.Provider>
        ))}
      </div>
    </section>
  );
}

// the tokens of @bunvex/ui/styles.css, in pairs a screen uses together (UI-01 §4.1)
const SURFACES = [
  ["background", "foreground"],
  ["card", "card-foreground"],
  ["popover", "popover-foreground"],
  ["primary", "primary-foreground"],
  ["secondary", "secondary-foreground"],
  ["muted", "muted-foreground"],
  ["accent", "accent-foreground"],
  ["destructive", "destructive-foreground"],
  ["success", "success-foreground"],
  ["warning", "warning-foreground"],
  ["info", "info-foreground"],
  ["sidebar", "sidebar-foreground"],
] as const;
const LINES = ["border", "input", "ring", "highlight", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];

function Colors() {
  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SURFACES.map(([bg, fg]) => (
          <li key={bg} className="border p-2 text-xs" style={{ background: `var(--${bg})`, color: `var(--${fg})` }}>
            <span className="font-medium">{bg}</span>
            <br />
            <span className="font-mono">on {fg}</span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-3 text-xs">
        {LINES.map((name) => (
          <li key={name} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="size-4 border" style={{ background: `var(--${name})` }} />
            <span className="font-mono">{name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function FormControls() {
  const box = useId("agree");
  const name = useId("name");
  const notes = useId("notes");
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={name} className="text-sm">
        Table name
      </label>
      <Input id={name} placeholder="Untitled table" />
      <label htmlFor={notes} className="text-sm">
        Notes
      </label>
      <Textarea id={notes} placeholder="Several lines" />
      <span className="flex items-center gap-2 text-sm">
        <Checkbox id={box} defaultChecked />
        <label htmlFor={box}>Show system fields</label>
      </span>
      <Input aria-label="Invalid example" aria-invalid defaultValue="9lives" />
    </div>
  );
}

type Row = { id: string; name: string; credits: number };
const col = dataTableColumns<Row>();
const COLUMNS = col.columns([col.accessor("name", { header: "name" }), col.accessor("credits", { header: "credits" })]);
const ROWS: Row[] = [
  { id: "a", name: "Ada Lovelace", credits: 42 },
  { id: "b", name: "Alan Turing", credits: 7 },
  { id: "c", name: "Grace Hopper", credits: 19 },
];

function DataSpecimens() {
  const theme = useContext(Panel); // landmarks need distinct names across the two panels
  return (
    <>
      <DataTable label={`Example rows (${theme})`} columns={COLUMNS} data={ROWS} getRowId={(r) => r.id} />
      <JsonView label={`Example document (${theme})`} value={{ _id: "k57a…", name: "Ada", tags: ["math"] }} />
      <Sparkline values={[3, 5, 4, 8, 6, 9, 7, 11]} summary="Commits per second, rising" />
      <Skeleton className="h-6 w-2/3" />
    </>
  );
}

function Page() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-4 py-3 md:px-6">
        <h1 className="text-xl font-semibold tracking-tight">bunvex design system</h1>
        <ThemeToggle />
      </header>
      <main className="mx-auto flex max-w-6xl flex-col gap-10 p-4 md:p-6">
        <p className="max-w-prose text-sm text-muted-foreground">
          The tokens and components of <code className="font-mono text-xs">@bunvex/ui</code>, each in both themes. The
          page's own theme (the toggle) only changes what is around them.
        </p>
        <Specimen title="Colors">
          <Colors />
        </Specimen>
        <Specimen title="Type">
          <p className="text-xl font-semibold tracking-tight">A screen's heading</p>
          <p className="text-base font-medium">A section's heading</p>
          <p className="text-sm">Body text, at the dashboard's size.</p>
          <p className="text-sm text-muted-foreground">Secondary text, for what explains.</p>
          <code className="font-mono text-xs">tasks:list · k57a0d8e3f2…</code>
        </Specimen>
        <Specimen title="Buttons">
          <div className="flex flex-wrap gap-2">
            <Button>Save</Button>
            <Button variant="outline">Cancel</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Delete</Button>
            <Button variant="link">Link</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs">Extra small</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button disabled>Disabled</Button>
            <CopyButton text="http://127.0.0.1:3210" label="Copy" />
          </div>
        </Specimen>
        <Specimen title="Badges">
          <div className="flex flex-wrap gap-2">
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Failed</Badge>
          </div>
        </Specimen>
        <Specimen title="Form controls">
          <FormControls />
        </Specimen>
        <Specimen title="Card and tabs">
          <Card>
            <CardHeader>
              <CardTitle>Documents</CardTitle>
              <CardDescription>Across every table</CardDescription>
            </CardHeader>
            <CardContent className="text-2xl font-semibold">1 452</CardContent>
          </Card>
          <Tabs defaultValue="saved">
            <TabsList>
              <TabsTrigger value="saved">Saved</TabsTrigger>
              <TabsTrigger value="generated">Generated</TabsTrigger>
            </TabsList>
            <TabsContent value="saved" className="text-sm">
              The schema in bunvex/schema.ts.
            </TabsContent>
            <TabsContent value="generated" className="text-sm">
              A schema from the documents.
            </TabsContent>
          </Tabs>
        </Specimen>
        <Specimen title="Data">
          <DataSpecimens />
        </Specimen>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <Page />
    </ThemeProvider>
  </StrictMode>,
);
