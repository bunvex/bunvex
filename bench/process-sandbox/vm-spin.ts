// STUDY-168: today's executor running `sb:spin` (a synchronous infinite loop), for sandbox.test.ts: it never ends.
import { setup } from "./setup.ts";

const s = await setup("vm");
await s.functions.runQuery("sb:spin", {});
console.log("returned");
