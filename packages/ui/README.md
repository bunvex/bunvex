# @bunvex/ui

The bunvex design system: Tailwind CSS v4 tokens, light and dark themes, and shadcn/ui components built on
Base UI primitives (style `base-lyra`). It depends on no other bunvex package.

**Status:** in use by `@bunvex/dashboard` — see [UI-01](../../docs/specs/UI-01-ui-and-dashboard.md) and
[ARCHITECTURE.md](../../ARCHITECTURE.md). Private (not published).

## Using it

```css
/* your stylesheet */
@import "tailwindcss";
@import "@bunvex/ui/styles.css";
@source "../node_modules/@bunvex/ui/src"; /* so Tailwind sees the classes the components use */
```

```tsx
import { Button } from "@bunvex/ui/components/button";
import { ThemeProvider } from "@bunvex/ui/theme";
```

The `exports` map is the public API: `components/*`, `lib/*`, `styles.css`, `theme` and `theme-script`
(an inline script that sets the theme class before the first paint).

## What is in it

- **Tokens** (`src/styles/globals.css`): OKLCH colours for `:root` and `.dark`, every text / background
  pair at WCAG AA or better (checked by `test/tokens.test.ts`). `ThemeProvider` / `useTheme` handle
  light, dark and system.
- **Components**: button, badge, status badge, card, checkbox, radio group, choice radios, choice select,
  input, textarea, select, file picker, tabs, popover, dropdown menu (with submenus that survive a fast
  pointer), dialog, alert dialog, tooltip, separator, skeleton, copy button, JSON view, data table, day
  input, sparkline, line chart, heatmap, map, resize handle, theme toggle — most from
  shadcn/ui (`components.json`), adjusted for bunvex.
- **`CodeEditor`**: Monaco, bundled (no CDN) and loaded on demand, with a language for JavaScript
  literals; a plain field with the same keys stands in until it loads and in tests (UI-01 §12.5.7).
- **`DataTable`**: TanStack Table + Virtual for long lists; with `grid` it is an ARIA data grid (one tab
  stop, arrows / Home / End / PageUp / PageDown, Enter or F2 to edit through the caller's editor, selection with Shift-click ranges, live change highlighting, column order / visibility /
  widths, dragging a header to reorder, a sticky column, a context menu per cell, and `fill` to take the
  whole height of its container). The column header is a quiet label row: the rows' background, small
  muted text.
- `apps/dashboard`'s `/design-system.html` shows the tokens and components in both themes (UI-01 §17.5).

## Accessibility

- Keyboard first: every control is reachable and operable from the keyboard, with a visible focus ring.
- Motion: `prefers-reduced-motion` stops animations and transitions; the grid's change highlight becomes
  a steady tint instead of a flash.
- Tests run axe on each component's states (colour contrast is checked on the tokens instead, since the
  test DOM has no layout).

## Tests

`bun run test` in this package (its own process, with happy-dom preloaded by `bunfig.toml`); the root
`bun run check` runs it too.
