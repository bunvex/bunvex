import { cronJobs } from "bunvex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every 10 seconds, so the page shows it soon; a real app would say { minutes: 1 }, or use a cron string.
crons.interval("clear the messages", { seconds: 10 }, internal.messages.clearAll);

export default crons;
