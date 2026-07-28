/**
 * `@vercel/detect-agent` browser shim. Upstream detects whether code runs
 * inside an AI agent (Cursor, Claude, etc.) by inspecting env vars — none of
 * which exist in a browser. Deterministic answer: not an agent.
 */
export async function determineAgent(): Promise<{ isAgent: boolean; agent: null }> {
  return { isAgent: false, agent: null };
}

export default { determineAgent };
