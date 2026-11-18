#!/usr/bin/env node
import { runMcp } from "./run";

runMcp().catch((e) => {
  console.error("groundwork-mcp:", e);
  process.exit(1);
});
