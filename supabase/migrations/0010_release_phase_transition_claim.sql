-- ===========================================================================
-- 0010_release_phase_transition_claim.sql
--
-- Fix (P0): a failed resolution left the transition claim held, freezing the
-- room until the claim timeout expired.
--
-- `claim_phase_transition` takes mutual exclusion by writing a random token
-- into `rooms.transition_claim`. `commit_phase_transition` and `finish_game`
-- both clear it, but ONLY on the success path: they authorise with
-- `where id = p_room_id and transition_claim = p_claim` and return
-- `{ok:false, code:'claim_lost'}` when that predicate misses.
--
-- So any resolution that fails BETWEEN claiming and settling -- a rejected RPC,
-- a transient database error, a network drop, any throw inside the resolution
-- -- left the claim in place. While it was held, `claim_phase_transition`
-- refused every other worker (it only re-claims once `transition_claimed_at`
-- is older than `p_claim_timeout_seconds`, 30s). If the failure was persistent
-- the room stayed wedged indefinitely with an expired `phase_ends_at`: the
-- countdown read zero, every client request returned "not advanced", and the
-- game could never reach `finished`.
--
-- This adds the missing release step so the claim is dropped as soon as the
-- worker knows it is not going to settle, letting the very next request retry
-- instead of waiting out the timeout.
--
-- Safety: the token is the authorisation. `and r.transition_claim = p_claim`
-- means a worker can only ever release ITS OWN claim, never one a competing
-- worker has since taken, and never a claim belonging to a settled transition
-- (both settling RPCs already null it). `and r.status = 'in_progress'`
-- refuses to touch a room that finished through some other path.
--
-- `state_version` is deliberately NOT decremented. The claim incremented it, and
-- that increment is what invalidated any other in-flight worker holding the
-- previous version. Rolling it back could let a superseded worker commit.
-- Leaving it raised is safe: the next reader simply observes the new value.
--
-- Grants mirror every other mutation RPC: service-role only.
-- ===========================================================================

create or replace function public.release_phase_transition_claim(
  p_room_id uuid,
  p_claim    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.rooms r
     set transition_claim = null,
         transition_claimed_at = null,
         updated_at = now()
   where r.id = p_room_id
     and r.transition_claim = p_claim
     and r.status = 'in_progress'
     and r.phase <> 'finished';

  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', 'claim_not_held',
      'message', 'No matching in-progress transition claim to release.'));
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Defence in depth: service-role only, exactly like claim/commit/finish.
revoke all on function public.release_phase_transition_claim(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_phase_transition_claim(uuid, uuid) to service_role;