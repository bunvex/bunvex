#!/usr/bin/env bun
// `bunvex dashboard serve` alone, compiled into the dashboard image (docker/dashboard.Dockerfile, DV-475).
import { dashboardServeCommand } from "../src/dashboard-serve.ts";
import { processIo } from "../src/io.ts";

process.exit(await dashboardServeCommand(process.argv.slice(2), processIo()));
