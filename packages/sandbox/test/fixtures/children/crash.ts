import { hello, requests } from "./fake.ts";

await hello();
await requests(() => {
  process.stderr.write("the child fell over\n");
  process.exit(3);
});
