import { fetchQuery } from "bunvex/nextjs";
import type { NextApiRequest, NextApiResponse } from "next";
import { api } from "../../bunvex/_generated/api";

/** The counter, read on the server: `fetchQuery` calls the deployment over HTTP. */
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  const clicks = await fetchQuery(api.counter.get, { name: "clicks" });
  res.status(200).json({ clicks });
}
