// Vite's `?worker` imports (used by the Monaco editor): the module is a Worker constructor.
declare module "*?worker" {
  const WorkerConstructor: { new (): Worker };
  export default WorkerConstructor;
}

// Vite's `?url` imports (MapLibre's worker): the module is the asset's URL.
declare module "*?url" {
  const url: string;
  export default url;
}
