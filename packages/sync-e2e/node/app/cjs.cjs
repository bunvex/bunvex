// Run by `node` (../npm-packages.node.ts): the same packages through `require`, as a CommonJS app loads them.
// Prints one JSON line.
const { anyApi, BunvexHttpClient, VERSION } = require("@bunvex/client");
const { BunvexReactClient } = require("@bunvex/react");
const { makeFunctionReference } = require("@bunvex/server");
const { BunvexError } = require("@bunvex/values");

async function main() {
  const http = new BunvexHttpClient(process.argv[2]);
  const sent = await http.mutation(anyApi.messages.send, { body: "from require" });
  const listed = await http.query(makeFunctionReference("messages:list"), {});
  const error = await http.mutation(anyApi.messages.fail, {}).catch((e) => e);
  console.log(
    JSON.stringify({
      version: VERSION,
      sent,
      listed,
      error: { bunvexError: error instanceof BunvexError, code: error.data?.code },
      react: typeof BunvexReactClient,
    }),
  );
}
main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
