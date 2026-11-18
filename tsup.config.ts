import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };

export default defineConfig({
  entry: { index: "src/index.ts", mcp: "src/mcp/main.ts", cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  dts: { entry: { index: "src/index.ts" } },
  define: { __VERSION__: JSON.stringify(version) },
  clean: true,
  sourcemap: true,
});
