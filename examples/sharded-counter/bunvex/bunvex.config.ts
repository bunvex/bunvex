// The app's components: the sharded counter twice, as in the package's own example. `shardedCounter` counts the
// users (and beans and pennies); `checkboxCounter` counts the checked boxes.
import shardedCounter from "@bunvex/sharded-counter/bunvex.config.js";
import { defineApp } from "bunvex/server";

const app = defineApp();
app.use(shardedCounter);
app.use(shardedCounter, { name: "checkboxCounter" });

export default app;
