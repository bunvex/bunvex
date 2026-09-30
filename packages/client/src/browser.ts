// The little of the browser the client uses (`beforeunload`, `online`), typed here so the package builds
// without the DOM library; `browserWindow()` is undefined outside a browser (Bun, Node, React Native without
// addEventListener).
type BrowserEvent = { preventDefault(): void; returnValue?: unknown };
export type BrowserWindow = {
  addEventListener(type: string, fn: (e: BrowserEvent) => unknown): void;
  removeEventListener(type: string, fn: (e: BrowserEvent) => unknown): void;
};

export function browserWindow(): BrowserWindow | undefined {
  const w = (globalThis as { window?: Partial<BrowserWindow> }).window;
  return w && typeof w.addEventListener === "function" && typeof w.removeEventListener === "function"
    ? (w as BrowserWindow)
    : undefined;
}

export const isBrowser = () => (globalThis as { window?: unknown }).window !== undefined;
