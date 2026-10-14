-- ===========================================================================
-- 0006_finish_game_persists_eliminations.sql
--
-- Fix (P0): the elimination that TRIGGERS a win was never persisted.
--
-- `finish_game` was the only RPC on the terminal path, and it accepted
--   (p_room_id, p_claim, p_winner, p_winner_counts)
-- and updated `rooms` + inserted `game_finished`. It never touched
-- `room_players`. Eliminations were only ever applied by
-- `commit_phase_transition`, which is deliberately NOT called when the game is
-- finishing (that RPC would flip the phase, and the phase is already
-- `finished`).
--
-- Consequence, reachable in the smallest legal game (4 players):
--   1 Werewolf / 1 Seer / 1 Doctor / 1 Villager.
--   Seer + Doctor + Villager vote out the Werewolf -> village wins.
--   `finish_game` runs -> the Werewolf is NEVER marked dead.
--   The public snapshot shows `is_alive: true` for the losing Werewolf on the
--   Game Over screen. GAME-RULES.md §9 requires `is_alive = false`,
--   `death_cause` and `died_at` to be set on elimination.
--
-- The same loss occurs on the night path when a night kill ends the game.
--
-- Fix: give `finish_game` the same `p_eliminations` payload
-- `commit_phase_transition` already accepts, and apply it with the identical
-- guarded UPDATE. Authorisation is unchanged — the claim token is still the
-- authorisation, and a forged/stale claim still fails closed.
--
-- Ordering, per GAME-RULES.md §9/§10: eliminations are applied FIRST, so the
-- room is already in its true terminal state before the `game_finished` event
-- is appended. A listener reading that event therefore never observes a
-- finished room in which the elimination is still pending.
--
-- Idempotence: the UPDATE is guarded by `and rp.is_alive`, so replaying a
-- resolution (which the claim protocol explicitly permits) cannot double-write
-- a row, reset `died_at`, or resurrect a player.
--
-- Scope guard: `and rp.room_id = p_room_id`, so a malformed payload cannot
-- mutate a player in another room.
--
-- The four-argument overload is DROPPED below. `CREATE OR REPLACE` matches on
-- the full argument list, so redefining with an extra parameter would otherwise
-- leave the old body alive under the old signature — still carrying the bug,
-- and still holding whatever EXECUTE grants it had. Dropping it first means
-- there is exactly one `finish_game` and no stale callable path.
--
-- Deploy note: PostgREST caches the function catalogue in "db" schema mode, so
-- changing a signature requires a schema-cache reload before the new argument
-- is visible over HTTP. On Supabase that is either the automatic reload or an
-- explicit one; see the operational notes in the PR description. Nothing here
-- depends on which, because every caller passes all five arguments.
-- ===========================================================================

do $$
begin
  if to_regprocedure('public.finish_game(uuid,uuid,text,jsonb)') is not null then
    drop function public.finish_game(uuid, uuid, text, jsonb);
  end if;
end $$;

create or replace function public.finish_game(
  p_room_id      uuid,
  p_claim        uuid,
  p_winner       text,
  p_winner_counts jsonb,
  -- NOT defaulted, deliberately. A default would let a stale 4-argument caller
  -- silently omit the eliminations and reproduce exactly the bug this migration
  -- fixes — the game would finish with the decisive player still alive. A
  -- missing argument now fails loudly ("function does not exist") instead.
  -- It also keeps the PostgREST RPC signature unambiguous: PostgREST builds its
  -- operation cache from pg_proc, and functions with trailing defaults have
  -- historically been handled inconsistently across versions.
  p_eliminations jsonb  -- [{"playerId":"...","cause":"vote_elimination"}]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_room   public.rooms%rowtype;
  v_elim   jsonb;
begin
  -- --- 1. Authorise AND publish the terminal state in ONE guarded UPDATE -----
  -- The `transition_claim = p_claim` predicate IS the authorisation. Doing it
  -- as the first statement matters for more than tidiness: a plpgsql `RETURN`
  -- COMMITS whatever the transaction already did — it does not roll back. So a
  -- separate "check the claim, then act" shape could apply eliminations and
  -- only afterwards discover the claim had been stolen, leaving kills written
  -- on a game that never reached `finished`.
  --
  -- Writing this first means a failed authorisation matches zero rows and
  -- returns with NOTHING written. Once it succeeds it has also cleared
  -- `transition_claim`, so no competing worker can advance this transition
  -- while the eliminations and the event are appended.
  update public.rooms
     set status = 'finished',
         phase = 'finished',
         phase_ends_at = null,
         transition_claim = null,
         transition_claimed_at = null,
         settings = settings || jsonb_build_object('winner', p_winner),
         expires_at = now() + interval '24 hours',
         last_activity_at = now(),
         updated_at = now()
   where id = p_room_id
     and transition_claim = p_claim
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_lost',
      'message', 'The transition claim was lost or already committed.'));
  end if;

  -- --- 2. Apply the eliminations that triggered the win --------------------
  -- Same guarded UPDATE as commit_phase_transition:
  --   * `and rp.room_id = p_room_id` -> a malformed payload cannot reach
  --                                    another room
  --   * `and rp.is_alive`            -> applied EXACTLY ONCE. A replayed
  --                                    resolution re-runs this as a no-op
  --                                    instead of a second write or a reset
  --                                    of died_at.
  -- coalesce is defensive only: the argument is required, so null means a
  -- caller passed an explicit null. Treating that as "nothing to eliminate" is
  -- safer than erroring after the room has already been flipped to finished.
  for v_elim in
    select * from jsonb_array_elements(coalesce(p_eliminations, '[]'::jsonb))
  loop
    update public.room_players rp
       set is_alive = false,
           death_cause = (v_elim->>'cause')::kill_cause,
           died_at = now()
     where rp.id = (v_elim->>'playerId')::uuid
       and rp.room_id = p_room_id
       and rp.is_alive;
  end loop;

  -- --- 3. Public event, written after the eliminations --------------------
  -- Everything above is one transaction, so no client ever observes the room as
  -- finished-but-not-yet-eliminated. Within the transaction the ordering is
  -- still meaningful: this row is what clients read for the outcome, so the
  -- board state it describes is already correct.
  insert into public.game_events (room_id, event_type, public_payload, round_number)
  values (p_room_id, 'game_finished', jsonb_build_object(
    'winner', p_winner,
    'aliveWerewolves', (p_winner_counts->>'aliveWerewolves')::int,
    'aliveNonWerewolves', (p_winner_counts->>'aliveNonWerewolves')::int
  ), v_room.round_number);

  return jsonb_build_object('ok', true, 'winner', p_winner);
end;
$$;

-- Grants are unchanged: finish_game stays service-role only, exactly like
-- every other mutation RPC. Re-stated here so a future refactor cannot
-- silently widen it while replacing the function body.
revoke all on function public.finish_game(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.finish_game(uuid, uuid, text, jsonb, jsonb) to service_role;