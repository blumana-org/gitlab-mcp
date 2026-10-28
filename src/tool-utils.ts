const text = (body: string) => ({ content: [{ type: "text" as const, text: body }] });

/** Objects are sent as pretty JSON; strings (pre-formatted compact output) as is. */
export const json = (data: unknown) => text(typeof data === "string" ? data : JSON.stringify(data, null, 2));

// Logs one line per call on stderr (safe in stdio mode) and turns errors into tool errors.
export function safe<A>(name: string, fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    const start = performance.now();
    const elapsed = () => `${Math.round(performance.now() - start)}ms`;
    try {
      const result = json(await fn(args));
      console.error(`[tool] ${name} ok ${elapsed()}`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[tool] ${name} error ${elapsed()}: ${message}`);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  };
}
