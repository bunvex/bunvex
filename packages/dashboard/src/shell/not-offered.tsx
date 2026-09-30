// A screen for a feature the source does not have (an optional contract method, UI-01 §14): the sidebar
// always lists it, as Convex's does, and the screen says why it is empty.
export function NotOffered({ title, what }: { title: string; what: string }) {
  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted-foreground">This deployment does not offer {what} yet.</p>
    </>
  );
}
