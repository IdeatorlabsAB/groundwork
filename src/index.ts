/** Groundwork's core: types, rules and the file store, for tools that build on Groundwork projects. */
export * from "./core/types";
export * from "./core/collections";
export * as ops from "./core/ops";
export * from "./core/schemas";
export * from "./core/requirements";
export * from "./core/verdict";
export * from "./core/hypothesis";
export * from "./core/trace";
export * from "./store/config";
export { load, save, assignIds, parseItem, renderItem, COLLECTIONS, type Loaded } from "./store/files";
export { validate, type Problem } from "./store/validate";
export { buildServer, INSTRUCTIONS } from "./mcp/server";
