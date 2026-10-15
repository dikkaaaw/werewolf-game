-- Drop the generic pending-actions framework (E2).
--
-- 0012 built `game_pending_actions` plus create/resolve/finalize RPCs as a
-- general durable post-death-choice abstraction. When the Hunter shipped it
-- used a separate death-resolution path (0013-0021) instead, so no application
-- code ever created or resolved a row here. A repository-wide reference audit
-- found the only consumers were the now-deleted
-- /api/internal/pending-actions routes and their unit test.
--
-- Written as a forward migration rather than an edit to 0012 so an
-- already-linked remote project converges with `supabase db push`. Every
-- statement is idempotent, so it is safe whether or not 0012 was applied.

drop function if exists public.finalize_expired_pending_actions(integer);
drop function if exists public.resolve_pending_action(uuid, uuid, jsonb);
drop function if exists public.create_pending_action(
  uuid, integer, uuid, text, timestamptz, uuid, jsonb
);
drop table if exists public.game_pending_actions cascade;
