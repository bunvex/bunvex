// A cron job, which the module list reports as the crons module's `cronSpecs`.
import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
crons.daily("nightly", { hourUTC: 3, minuteUTC: 30 }, makeFunctionReference<"mutation">("messages:send"), {
  body: "cron",
});
export default crons;
