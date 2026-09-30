// Vite's `?worker` imports (used by the Monaco editor): the module is a Worker constructor.
declare module "*?worker" {
  const WorkerConstructor: { new (): Worker };
  export default WorkerConstructor;
}
