/** Types for the Action's entry point, so the tests (TypeScript) can import the plain-JavaScript Action. */
export function run(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
  exec?: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined> }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<number>;
