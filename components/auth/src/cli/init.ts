#!/usr/bin/env bun
// The package's command, `bunx @bunvex/auth`: see `program.ts`.
import { runInit } from "./program.ts";

process.exit(runInit(process.argv.slice(2)));
