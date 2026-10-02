#!/usr/bin/env bun
import { main } from "../src/index.ts";

process.exit(await main(process.argv.slice(2)));
