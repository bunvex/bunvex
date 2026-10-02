import { describe, expect, test } from "bun:test";
import { Tabs, TabsList, TabsTrigger } from "@bunvex/ui/components/tabs";
import { render, screen } from "@testing-library/react";

// UX-7, UX2-6: one tab pattern — underlined — unless a screen asks for the segmented look on purpose
describe("Tabs", () => {
  test("a tab list is underlined by default", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList aria-label="Sections">
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    expect(screen.getByRole("tablist", { name: "Sections" }).getAttribute("data-variant")).toBe("line");
  });
});
