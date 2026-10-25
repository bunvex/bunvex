import { cronJobs, makeFunctionReference } from "@bunvex/server";

const crons = cronJobs();
crons.interval("slow tick", { hours: 1 }, makeFunctionReference<"action">("slow:tick"));
export default crons;
