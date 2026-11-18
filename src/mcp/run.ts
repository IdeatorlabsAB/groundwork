import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { findRoot } from "../store/config";
import { buildServer } from "./server";

/** Groundwork's MCP server over stdio, for the project in the working directory (or $GROUNDWORK_DIR). */
export async function runMcp() {
  const server = buildServer({ root: findRoot() });
  await server.connect(new StdioServerTransport());
}
