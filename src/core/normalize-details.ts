/**
 * One canonical shape for a proposal's `details`.
 *
 * The stored shape is `[{name, value}]`. An agent writing through the MCP
 * produced the OTHER obvious shape instead, a plain map:
 *
 *   "details": { "email": "someone@example.com" }
 *
 * Two rows like that took a user's entire /app home page down with
 * `TypeError: a?.find is not a function`, because the dashboard does
 * `details?.find(...)` and optional chaining guards null, not "not an array".
 * The same rows would have thrown again on accept: `applyCreateNode` spreads
 * `[...details]` and `applyAddDetail` runs `for (const d of details)`, and an
 * object is not iterable.
 *
 * So this is not defensive padding around one crash. `pending_writes.payload`
 * is JSONB written by a model, which means its shape is an INPUT, not an
 * invariant, and every reader of it has to be total. Normalize on the way in
 * and on the way out; never index into the raw payload.
 *
 * Deliberately permissive about values: a number or boolean becomes its string
 * form rather than being dropped, and an array value becomes one entry per
 * element so a multi-value detail survives. Anything genuinely unusable
 * (nested objects, null, empty strings) is dropped rather than stringified
 * into "[object Object]", which would land in the graph as a fact.
 */
export type GraphDetail = { name: string; value: string };

function coerceValue(raw: unknown): string[] {
  if (typeof raw === "string") return [raw];
  if (typeof raw === "number" || typeof raw === "boolean") return [String(raw)];
  if (Array.isArray(raw)) return raw.flatMap(coerceValue);
  return [];
}

export function normalizeDetails(raw: unknown): GraphDetail[] {
  if (!raw) return [];

  const out: GraphDetail[] = [];

  const push = (name: unknown, value: unknown) => {
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) return;
    for (const v of coerceValue(value)) {
      const trimmed = v.trim();
      if (trimmed) out.push({ name: key, value: trimmed });
    }
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      push(e.name, e.value);
    }
    return out;
  }

  if (typeof raw === "object") {
    // The map shape: {email: "...", company: "..."}. Its keys ARE the detail
    // names, which is why this is worth rescuing instead of discarding: the
    // information is all there, only the container is wrong.
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      push(key, value);
    }
    return out;
  }

  return [];
}
