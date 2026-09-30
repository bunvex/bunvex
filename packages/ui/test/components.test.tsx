import { describe, expect, mock, test } from "bun:test";
import { Badge } from "@bunvex/ui/components/badge";
import { Button } from "@bunvex/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@bunvex/ui/components/card";
import { Separator } from "@bunvex/ui/components/separator";
import { Skeleton } from "@bunvex/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@bunvex/ui/components/tooltip";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expectAccessible } from "./axe.ts";

describe("Button", () => {
  test("is a native button, reachable and pressable with the keyboard", async () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Save</Button>);
    const user = userEvent.setup();
    await user.tab();
    const button = screen.getByRole("button", { name: "Save" });
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");
    expect(onClick).toHaveBeenCalledTimes(2);
    await expectAccessible();
  });

  test("disabled: not focusable, not pressable", async () => {
    const onClick = mock();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(document.body);
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  test("render composes onto another element (Base UI's replacement for asChild)", () => {
    render(
      <Button render={<a href="/tables" />} nativeButton={false}>
        Tables
      </Button>,
    );
    const link = screen.getByRole("button", { name: "Tables" });
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/tables");
    expect(link.className).toContain("inline-flex");
  });

  test("variants map to token classes and className overrides win", () => {
    render(
      <Button variant="destructive" className="px-8">
        Delete
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Delete" });
    expect(b.className).toContain("text-destructive");
    expect(b.className).toContain("px-8");
    expect(b.className).not.toContain("px-2.5");
  });
});

describe("Tooltip", () => {
  test("opens on keyboard focus and labels its trigger", async () => {
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" />}>Refresh</TooltipTrigger>
          <TooltipContent>Reload the page of documents</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    const user = userEvent.setup();
    await user.tab();
    expect(await screen.findByText("Reload the page of documents")).toBeDefined();
    await user.keyboard("{Escape}");
  });
});

describe("static components", () => {
  test("card, badge, separator and skeleton render accessible markup", async () => {
    render(
      <main>
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>Commits</h2>
            </CardTitle>
            <CardDescription>since start</CardDescription>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary">live</Badge>
            <Separator />
            <Skeleton className="h-4 w-20" />
          </CardContent>
        </Card>
      </main>,
    );
    expect(screen.getByRole("heading", { name: "Commits" })).toBeDefined();
    expect(screen.getByText("live").dataset.slot).toBe("badge");
    await expectAccessible();
  });
});

describe("Checkbox", () => {
  test("a partial state reads as mixed and shows a dash, not a tick", async () => {
    const { Checkbox } = await import("@bunvex/ui/components/checkbox");
    render(<Checkbox aria-label="Some rows" indeterminate checked={false} />);
    const box = screen.getByRole("checkbox", { name: "Some rows" });
    expect(box.getAttribute("aria-checked")).toBe("mixed");
    const [tick, dash] = [...box.querySelectorAll("svg")];
    expect(tick?.getAttribute("class")).toContain("group-data-indeterminate/checkbox:hidden");
    expect(dash?.getAttribute("class")).toContain("group-data-indeterminate/checkbox:block");
    expect(box.hasAttribute("data-indeterminate")).toBe(true);
  });
});
