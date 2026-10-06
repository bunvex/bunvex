// The Database screen's section column (UI-01 §23): search, "Create table" where the credential can write,
// then one link per table with its size and a marker on tables the schema does not declare; for a credential
// that may view data, "Show system tables" lists the system tables under them (STUDY-131 AD-24). Resizable, its
// width kept in this browser. Below lg it is a picker above the table instead.
import { Checkbox } from "@bunvex/ui/components/checkbox";
import { Input } from "@bunvex/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@bunvex/ui/components/select";
import { Lock, Table2 } from "lucide-react";
import { useId, useState } from "react";
import type { TableInfo } from "../data-source.ts";
import { DashLink, tableRoute } from "../router.tsx";
import { formatCount } from "../screens/stats.ts";
import { SECTION_ITEM, SectionColumn } from "../shell/section-column.tsx";
import { CreateTable } from "./create-table.tsx";
import { useCanViewSystemTables, useShowSystemTables, useSystemTables } from "./system-table.tsx";

const WIDTH_KEY = "bunvex-dashboard:tables-width";
export function TablesSidebar(props: { tables: TableInfo[]; current: string; canCreate: boolean }) {
  const { tables, current } = props;
  const [query, setQuery] = useState("");
  const searchId = useId();
  const pickerLabel = useId();
  const navigate = tableRoute.useNavigate();
  const sorted = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const shown = sorted.filter((t) => matches(t.name));
  // the system tables (STUDY-131 AD-24): behind a switch, for a credential that may view data; an open
  // system table keeps them listed
  const canViewSystem = useCanViewSystemTables();
  const [showSystem, setShowSystem] = useShowSystemTables();
  const systemListed = canViewSystem && (showSystem || current.startsWith("_"));
  const systemTables = useSystemTables(systemListed).filter((t) => matches(t.name));
  const systemSwitchId = useId();
  return (
    <>
      {sorted.length > 0 && (
        <div className="flex items-center gap-2 border-b px-4 py-2 lg:hidden">
          <span id={pickerLabel} className="text-sm text-muted-foreground">
            Table
          </span>
          <Select
            items={sorted.map((t) => ({ value: t.name, label: t.name }))}
            value={current}
            onValueChange={(v) => navigate({ to: "/database/$table", params: { table: v as string } })}
          >
            <SelectTrigger aria-labelledby={pickerLabel} className="min-w-40 flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sorted.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <SectionColumn title="Database" widthKey={WIDTH_KEY} from="lg">
        <nav aria-label="Tables">
          <div className="px-3 pt-3">
            <label htmlFor={searchId} className="sr-only">
              Search tables
            </label>
            <Input
              id={searchId}
              type="search"
              className="h-7"
              placeholder="Search tables"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {/* the primary action, first in the group (it turns into a name box in place) */}
          {props.canCreate && (
            <div className="px-1 pt-2">
              <CreateTable tables={tables.map((t) => t.name)} />
            </div>
          )}
          <h3 className="px-3 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            Tables
          </h3>
          <ul>
            {shown.map((t) => (
              <li key={t.name}>
                <DashLink link={{ to: "/database/$table", params: { table: t.name } }} className={SECTION_ITEM}>
                  <Table2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {t.name}
                    {!t.declared && (
                      <span className="ml-1 text-muted-foreground" title="Not in the schema">
                        *<span className="sr-only"> (not in the schema)</span>
                      </span>
                    )}
                  </span>
                  {t.documentCount !== undefined && (
                    <span className="text-xs text-muted-foreground tabular-nums">{formatCount(t.documentCount)}</span>
                  )}
                </DashLink>
              </li>
            ))}
            {sorted.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground">No tables yet.</li>
            ) : (
              shown.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted-foreground">No table matches “{query}”.</li>
              )
            )}
          </ul>
          {canViewSystem && (
            <div className="flex items-center gap-2 px-3 pt-4 pb-1">
              <Checkbox
                id={systemSwitchId}
                checked={showSystem}
                onCheckedChange={(checked) => setShowSystem(checked === true)}
              />
              <label htmlFor={systemSwitchId} className="text-xs text-muted-foreground">
                Show system tables
              </label>
            </div>
          )}
          {systemListed && (
            <>
              <h3 className="px-3 pt-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                System tables
              </h3>
              <ul aria-label="System tables">
                {systemTables.map((t) => (
                  <li key={t.name}>
                    <DashLink
                      link={{ to: "/database/$table", params: { table: t.name } }}
                      className={SECTION_ITEM}
                      title={t.description}
                    >
                      <Lock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{t.name}</span>
                      {t.documentCount !== null && (
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatCount(t.documentCount)}
                        </span>
                      )}
                    </DashLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>
      </SectionColumn>
    </>
  );
}
