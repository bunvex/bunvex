// A cron job of each kind the dashboard shows a schedule for: an interval (it runs at once) and a daily one.
import { cronJobs, makeFunctionReference } from "convex/server";

const crons = cronJobs();
crons.interval("tick", { hours: 1 }, makeFunctionReference<"mutation">("ops:workFn"), { i: -1 });
crons.daily("nightly", { hourUTC: 3, minuteUTC: 30 }, makeFunctionReference<"mutation">("ops:otherFn"), { i: -2 });
export default crons;
