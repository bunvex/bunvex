// The soak's cron: the trim every 10 s. (A far-away cron would never be the executor's next run beside it, so the
// soak cannot see a cron's long sleep; STUDY-174 F3 needs a unit test with an injected clock instead.)
import { anyApi, cronJobs } from "bunvex/server";

const crons = cronJobs();
crons.interval("trim", { seconds: 10 }, anyApi.messages.trim);
export default crons;
