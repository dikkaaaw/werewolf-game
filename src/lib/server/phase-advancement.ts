import 'server-only';

import { createAdminClient } from '@/lib/supabase/server';
import { resolveNight } from '@/lib/game/night-resolution';
import { resolveVote } from '@/lib/game/vote-resolution';
import { evaluateWinCondition } from '@/lib/game/win-condition';
import { SETTINGS } from '@/lib/game/settings';
import type { PlayerState, NightAction, GamePhase } from '@/lib/game/types';

/**
 * Lazy phase advancement fallback (PRD §17.3, IMPLEMENTATION-PLAN § "Scheduler strategy").
 *
 * Ensures an active room whose `phase_ends_at <= now()` is claimed, resolved,
 * and advanced to the next phase before processing client queries or mutations.
 *
 * Safe against race conditions via optimistic 2-step protocol:
 * 1. claim_phase_transition
 * 2. pure resolution
 * 3. commit_phase_transition / finish_game
 */
export async function advanceRoomPhaseIfExpired(roomId: string): Promise<boolean> {
  const admin = createAdminClient();

  // 1. Fetch current room state
  const { data: room, error: roomError } = await admin
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (roomError || !room || room.status !== 'in_progress') {
    return false;
  }

  // Not expired yet
  if (!room.phase_ends_at || new Date(room.phase_ends_at).getTime() > Date.now()) {
    return false;
  }

  const currentPhase = room.phase as GamePhase;
  const currentRound = room.round_number;
  const currentVersion = room.state_version;

  // 2. Step 1: Claim transition
  const { data: claimData, error: claimError } = await admin.rpc('claim_phase_transition', {
    p_room_id: roomId,
    p_expected_version: currentVersion,
    p_expected_phase: currentPhase,
    p_claim_timeout_seconds: 30,
  });

  if (claimError) return false;
  const claimBody = claimData as { ok: boolean; claim?: string };
  if (!claimBody.ok || !claimBody.claim) {
    return false; // Contended or lost race
  }

  const claimToken = claimBody.claim;

  // 3. Step 2: Pure resolution based on phase
  // The resolution body is factored out so the claim can be released on
  // EVERY non-settling exit, including the ones that `return` early.
  const attempt = async (): Promise<boolean> => {
  if (currentPhase === 'night') {
    // Gather player states & secrets
    const { data: roster } = await admin
      .from('room_players')
      .select('id, seat_number, display_name, is_alive')
      .eq('room_id', roomId);

    // Secrets are scoped to THIS room's roster. An unfiltered read would pull
    // every secret in the database into this process on every phase
    // resolution — needless private-data exposure and a full-table scan. The
    // lookup below is keyed by player id (a globally unique PK), so scoping
    // changes nothing about correctness; it only bounds what is loaded.
    const { data: secrets } = await admin
      .from('player_secrets')
      .select('player_id, role_key, alignment')
      .in('player_id', (roster ?? []).map((r) => r.id));

    const { data: actions } = await admin
      .from('game_actions')
      .select('id, actor_player_id, action_type, target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', currentRound);

    const secretsMap = new Map((secrets ?? []).map((s) => [s.player_id, s]));

    const playerStates: PlayerState[] = (roster ?? []).map((r) => {
      const sec = secretsMap.get(r.id);
      return {
        playerId: r.id,
        userId: '',
        seatNumber: r.seat_number,
        displayName: r.display_name,
        isAlive: r.is_alive,
        alignment: sec?.alignment ?? 'village',
        roleKey: sec?.role_key ?? 'villager',
      };
    });

    const nightActions: NightAction[] = (actions ?? []).map((a) => {
      const sec = secretsMap.get(a.actor_player_id);
      return {
        actorPlayerId: a.actor_player_id,
        actorRoleKey: sec?.role_key ?? 'villager',
        actionType: a.action_type,
        targetPlayerId: a.target_player_id ?? '',
      };
    });

    const resolution = resolveNight({
      players: playerStates,
      actions: nightActions,
    });

    // Write private investigation results to game_action_results
    if (resolution.private.investigations.length > 0) {
      for (const inv of resolution.private.investigations) {
        const actionRow = actions?.find(
          (a) => a.actor_player_id === inv.actorPlayerId && a.action_type === 'investigate',
        );
        if (actionRow) {
          const { error } = await admin.from('game_action_results').insert({
            room_id: roomId,
            round_number: currentRound,
            action_id: actionRow.id,
            actor_player_id: inv.actorPlayerId,
            result_type: 'investigate',
            result_payload: {
              targetPlayerId: inv.targetPlayerId,
              alignment: inv.targetAlignment,
            },
          });
          // Idempotent: if the Seer result for this (action_id, result_type) was
          // already persisted by an earlier attempt, the unique constraint
          // game_action_results_action_key will fire as a returned error.
          // handleInsertResultError accepts that conflict ONLY after reading
          // the stored row back and confirming it matches this investigation.
          // Any other database error propagates for observability and recovery.
          if (error) {
            await handleInsertResultError(
              admin as unknown as ActionResultsReader,
              error,
              actionRow.id,
              inv.targetPlayerId,
              inv.targetAlignment,
            );
          }
        }
      }
    }

    // Check win condition post-elimination
    const eliminatedIds = new Set(resolution.public.eliminated.map((e) => e.playerId));
    const postNightStates = playerStates.map((p) => ({
      ...p,
      isAlive: p.isAlive && !eliminatedIds.has(p.playerId),
    }));

    const winResult = evaluateWinCondition(postNightStates);

    if (winResult.hasWinner && winResult.winningAlignment) {
      // Finish game. The eliminations MUST be passed: finish_game is the only
      // RPC on the terminal path (commit_phase_transition would flip the
      // phase, and it is already `finished`), so omitting them silently
      // dropped the kill that triggered the win. The Werewolf who lost on
      // parity would still read `is_alive: true` in the final snapshot.
      const { data: finishData, error: finishError } = await admin.rpc('finish_game', {
        p_room_id: roomId,
        p_claim: claimToken,
        p_winner: winResult.winningAlignment,
        p_winner_counts: {
          aliveWerewolves: winResult.aliveWerewolves,
          aliveNonWerewolves: winResult.aliveNonWerewolves,
        },
        p_eliminations: resolution.public.eliminated as unknown as import('@/types/database').Json,
      });
      if (finishError) throw finishError;
      const finishBody = finishData as { ok?: boolean } | null;
      settled = Boolean(finishBody?.ok);
      return settled;
    }

    // Next phase: day
    const daySeconds = SETTINGS.phaseSeconds.day;
    const events = [
      { eventType: 'day_started', payload: { roundNumber: currentRound } },
      ...resolution.public.eliminated.map((e) => ({
        eventType: 'player_eliminated',
        payload: { playerId: e.playerId, seatNumber: e.seatNumber, displayName: e.displayName },
      })),
    ];

    const { data: commitData, error: commitError } = await admin.rpc('commit_phase_transition', {
      p_room_id: roomId,
      p_claim: claimToken,
      p_next_phase: 'day',
      p_round_number: currentRound,
      p_phase_seconds: daySeconds,
      p_eliminations: resolution.public.eliminated as unknown as import('@/types/database').Json,
      p_events: events as unknown as import('@/types/database').Json,
    });
    // A lost claim is NOT success. The night was never committed, so this
    // worker must report "not advanced" and let the winner of the race (or a
    // later retry) finish the transition. Returning true here would claim the
    // night advanced while the room is still sitting in `night`.
    if (commitError) throw commitError;
    const commitBody = commitData as { ok?: boolean } | null;
    settled = Boolean(commitBody?.ok);
    return settled;
  } else if (currentPhase === 'day') {
    // Transition from day discussion -> voting
    const votingSeconds = SETTINGS.phaseSeconds.voting;
    const { data: dayCommitData, error: dayCommitError } = await admin.rpc('commit_phase_transition', {
      p_room_id: roomId,
      p_claim: claimToken,
      p_next_phase: 'voting',
      p_round_number: currentRound,
      p_phase_seconds: votingSeconds,
      p_eliminations: [],
      p_events: [{ eventType: 'voting_started', payload: { roundNumber: currentRound } }],
    });
    if (dayCommitError) throw dayCommitError;
    const dayCommitBody = dayCommitData as { ok?: boolean } | null;
    settled = Boolean(dayCommitBody?.ok);
    return settled;
  } else if (currentPhase === 'voting') {
    // Gather alive players and votes
    const { data: roster } = await admin
      .from('room_players')
      .select('id, seat_number, display_name, is_alive')
      .eq('room_id', roomId)
      .eq('is_alive', true);

    // Scoped to this room's roster — see the note in the night branch.
    const { data: secrets } = await admin
      .from('player_secrets')
      .select('player_id, role_key, alignment')
      .in('player_id', (roster ?? []).map((r) => r.id));

    const { data: votes } = await admin
      .from('game_votes')
      .select('voter_player_id, target_player_id')
      .eq('room_id', roomId)
      .eq('round_number', currentRound);

    const secretsMap = new Map((secrets ?? []).map((s) => [s.player_id, s]));

    const aliveStates: PlayerState[] = (roster ?? []).map((r) => {
      const sec = secretsMap.get(r.id);
      return {
        playerId: r.id,
        userId: '',
        seatNumber: r.seat_number,
        displayName: r.display_name,
        isAlive: true,
        alignment: sec?.alignment ?? 'village',
        roleKey: sec?.role_key ?? 'villager',
      };
    });

    const voteResult = resolveVote({
      players: aliveStates,
      votes: (votes ?? []).map((v) => ({
        voterPlayerId: v.voter_player_id,
        targetPlayerId: v.target_player_id,
      })),
      tieRule: 'none',
    });

    // Check win condition
    const eliminatedId = voteResult.eliminated?.playerId;
    const postVoteStates = aliveStates.map((p) => ({
      ...p,
      isAlive: p.isAlive && p.playerId !== eliminatedId,
    }));

    const winResult = evaluateWinCondition(postVoteStates);

    if (winResult.hasWinner && winResult.winningAlignment) {
      // Same reason as the night path: the lynched player is the elimination
      // that ended the game, and it has to reach room_players.
      const { data: voteFinishData, error: voteFinishError } = await admin.rpc('finish_game', {
        p_room_id: roomId,
        p_claim: claimToken,
        p_winner: winResult.winningAlignment,
        p_winner_counts: {
          aliveWerewolves: winResult.aliveWerewolves,
          aliveNonWerewolves: winResult.aliveNonWerewolves,
        },
        p_eliminations: (voteResult.eliminated ? [voteResult.eliminated] : []) as unknown as import('@/types/database').Json,
      });
      if (voteFinishError) throw voteFinishError;
      const voteFinishBody = voteFinishData as { ok?: boolean } | null;
      settled = Boolean(voteFinishBody?.ok);
      return settled;
    }

    // Next phase: night (round + 1)
    const nextRound = currentRound + 1;
    const nightSeconds = SETTINGS.phaseSeconds.night;
    const events: Array<{ eventType: string; payload: Record<string, unknown> }> = [];

    if (voteResult.eliminated) {
      events.push({
        eventType: 'player_eliminated',
        payload: {
          playerId: voteResult.eliminated.playerId,
          seatNumber: voteResult.eliminated.seatNumber,
          displayName: voteResult.eliminated.displayName,
        },
      });
    }
    events.push({ eventType: 'night_started', payload: { roundNumber: nextRound } });

    const { data: voteCommitData, error: voteCommitError } = await admin.rpc('commit_phase_transition', {
      p_room_id: roomId,
      p_claim: claimToken,
      p_next_phase: 'night',
      p_round_number: nextRound,
      p_phase_seconds: nightSeconds,
      p_eliminations: (voteResult.eliminated ? [voteResult.eliminated] : []) as unknown as import('@/types/database').Json,
      p_events: events as unknown as import('@/types/database').Json,
    });
    if (voteCommitError) throw voteCommitError;
    const voteCommitBody = voteCommitData as { ok?: boolean } | null;
    settled = Boolean(voteCommitBody?.ok);
    return settled;
  }
    return false;
  };

  // `settled` is set ONLY by a settling RPC (`finish_game` /
  // `commit_phase_transition`) that actually reported `ok: true`. A lost claim,
  // a thrown error, or a phase with no branch all leave it false.
  let settled = false;
  try {
    settled = await attempt();
  } catch (err) {
    console.error('[advanceRoomPhase] error resolving phase transition:', err);
  }

  // A claim that outlives its worker freezes the room: `claim_phase_transition`
  // refuses to re-issue it until the 30s timeout expires, so an unresolved room
  // could never reach `finished`. Hand the claim back so the very next request
  // retries. Safe against contention because the token is the authorisation: a
  // worker can only ever release the claim it is actually holding.
  if (!settled) {
    await releaseTransitionClaim(admin, roomId, claimToken);
  }

  return settled;
}

/**
 * Hands a phase-transition claim back after a resolution that did not settle.
 *
 * Best-effort by design: it runs on an already-failed path, so a failure here
 * must not mask the original error or reject the caller's request. Worst case
 * the claim times out on its own, which is exactly the behaviour this replaces.
 */
async function releaseTransitionClaim(
  admin: ReturnType<typeof createAdminClient>,
  roomId: string,
  claimToken: string,
): Promise<void> {
  const { error } = await admin.rpc('release_phase_transition_claim', {
    p_room_id: roomId,
    p_claim: claimToken,
  });
  if (error) {
    console.error('[advanceRoomPhase] failed to release transition claim:', error);
  }
}

/**
 * Minimal structural type for the admin client used by the insert-idempotency
 * check. Declared locally so the helper stays unit-testable without importing
 * the full `server-only` Supabase module.
 */
export interface ActionResultsReader {
  from(table: 'game_action_results'): {
    select(columns: string): ActionResultsFilter;
  };
}

/** One `.eq(...)` step. Each call returns another filter, so the chain is
 *  self-referential rather than typed at a fixed depth. */
export interface ActionResultsFilter {
  eq(column: string, value: string): ActionResultsFilter & {
    maybeSingle(): PromiseLike<{
      data: { result_payload: unknown } | null;
      error: { message?: string } | null;
    }>;
  };
}

/**
 * Handles a PostgreSQL error from inserting a Seer investigation result into
 * public.game_action_results.
 *
 * A unique-violation (23505) is only accepted as idempotent success after
 * reading back the conflicting row and confirming its payload matches the
 * investigation this run produced. A duplicate that is missing, or that
 * disagrees about the target or the alignment, is a real inconsistency and
 * fails loudly instead of being swallowed. Every other error code propagates.
 *
 * @param reader           Client used to read back the conflicting row.
 * @param error            The PostgreSQL error returned from the insert.
 * @param actionRowId      The action_id that was inserted (part of the
 *                         game_action_results_action_key constraint).
 * @param targetPlayerId   The playerId that the investigation targeted.
 * @param targetAlignment  The alignment of the target player.
 */
export async function handleInsertResultError(
  reader: ActionResultsReader,
  error: { code: string | null; message?: string } | null,
  actionRowId: string,
  targetPlayerId: string,
  targetAlignment: string,
): Promise<void> {
  if (!error) return;
  if (error.code !== '23505') {
    throw error;
  }

  const { data: existingRow, error: readError } = await reader
    .from('game_action_results')
    .select('result_payload')
    .eq('action_id', actionRowId)
    .eq('result_type', 'investigate')
    .maybeSingle();
  if (readError) throw readError;

  const payload = existingRow?.result_payload as
    | { targetPlayerId?: string; alignment?: string }
    | null
    | undefined;

  if (
    !payload ||
    payload.targetPlayerId !== targetPlayerId ||
    payload.alignment !== targetAlignment
  ) {
    throw new Error(
      'Seer result idempotency check failed: existing payload does not match expected investigation.',
    );
  }
  // Matching duplicate – idempotent, do nothing.
}
