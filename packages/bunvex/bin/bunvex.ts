#!/usr/bin/env bun
// The `bunvex` command (@bunvex/cli), installed with the `bunvex` package.
import { main } from "@bunvex/cli";

process.exit(await main(process.argv.slice(2)));
