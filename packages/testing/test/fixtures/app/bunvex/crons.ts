import { cronJobs, makeFunctionReference } from "@bunvex/server";

const crons = cronJobs();
crons.interval("tick", { hours: 1 }, makeFunctionReference<"mutation">("messages:tick"));
export default crons;
