// Stands in for a screen that a later slice of UI-01 §9 builds, and for an unknown address.
export function NotBuiltYet({ title, message = "This screen is not built yet." }: { title: string; message?: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{message}</p>
    </>
  );
}
