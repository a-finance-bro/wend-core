-- 178: every SECURITY DEFINER function ships locked down.
--
-- THE RULE. A definer function runs with its owner's rights and therefore
-- bypasses row-level security. Postgres grants EXECUTE to PUBLIC on a newly
-- created function by default, so a definer function is reachable by anyone
-- holding the project's public key until something revokes it.
--
-- ⚠️ GRANTS ARE PER SIGNATURE, NOT PER NAME. Migration 010 revoked
-- recall_nodes(vector, int). That did nothing for the three-argument overload
-- added in 125, because an overload does not inherit an earlier signature's
-- grants. Any migration that adds or replaces a definer function repeats both
-- statements below for the exact new signature, in the same file.
--
-- Applied last so it covers every function the earlier files create.

revoke all on function public.recall_nodes(vector, integer, uuid) from public, anon;
grant execute on function public.recall_nodes(vector, integer, uuid) to authenticated, service_role;

revoke all on function public.recall_nodes(vector, integer) from public, anon;
grant execute on function public.recall_nodes(vector, integer) to authenticated, service_role;

revoke all on function public.search_person_attributes(text[], text, uuid, integer) from public, anon;
grant execute on function public.search_person_attributes(text[], text, uuid, integer) to authenticated, service_role;

revoke all on function public.search_person_attributes(text[], text, uuid, integer, boolean) from public, anon;
grant execute on function public.search_person_attributes(text[], text, uuid, integer, boolean) to authenticated, service_role;

-- The seed functions run from a trigger on user creation. A trigger executes as
-- the function owner and does not consult the caller's EXECUTE privilege, so
-- revoking here does not stop provisioning; it only stops a stranger calling
-- them directly with someone else's user id.
revoke all on function public.seed_user_graph(uuid) from public, anon;
grant execute on function public.seed_user_graph(uuid) to service_role;

revoke all on function public.seed_location_taxonomy(uuid) from public, anon;
grant execute on function public.seed_location_taxonomy(uuid) to service_role;

revoke all on function public.seed_extended_link_types(uuid) from public, anon;
grant execute on function public.seed_extended_link_types(uuid) to service_role;
