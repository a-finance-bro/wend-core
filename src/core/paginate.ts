/**
 * Pagination helper for PostgREST's `db-max-rows` cap.
 *
 * This Supabase project caps every API response at 1000 rows (the default
 * "Max Rows" API setting) and CLAMPS `.limit()` / `.range()` to it too — so a
 * single query that expects more than 1000 rows silently returns only the
 * first 1000 with no error. That's a correctness landmine on tables that grow
 * unbounded per user (node_details, links, nodes, messages, …).
 *
 * `selectAllRows` walks the full result in <=1000-row windows. Pass a factory
 * that builds the query and applies the given `.range(from, to)` window:
 *
 *   const nodes = await selectAllRows((from, to) =>
 *     supabase.from("nodes").select("id, display_name")
 *       .eq("user_id", userId).is("deleted_at", null)
 *       .order("id").range(from, to),
 *   );
 *
 * ORDER MATTERS: always include a stable `.order(...)` in the factory, or
 * paging windows can overlap/miss rows. `id` is a safe default.
 */

import type { PostgrestError } from "@supabase/supabase-js";

/** PostgREST page size — must be <= the project's db-max-rows (1000). */
export const PAGE_SIZE = 1000;

/** Hard stop so a bug can't loop forever (1M rows / 1000 = 1000 pages). */
const MAX_PAGES = 1000;

type PageResult<T> = { data: T[] | null; error: PostgrestError | null };

export async function selectAllRows<T>(
  makeQuery: (from: number, to: number) => PromiseLike<PageResult<T>>,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await makeQuery(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    // concat (not push(...spread)) stays safe for very large arrays.
    for (const row of data) out.push(row);
    if (data.length < PAGE_SIZE) break;
  }
  return out;
}
