// Driver module for the conformance suite: MongoDB at $MONGO_URL (a scratch database; fresh drops it).
import { MongoPersistence } from "@bunvex/persistence/mongodb";

export async function open(fresh: boolean) {
  return MongoPersistence.open(process.env.MONGO_URL!, { fresh });
}
