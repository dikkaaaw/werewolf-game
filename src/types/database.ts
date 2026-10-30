/**
 * Database row types.
 *
 * Hand-maintained to mirror supabase/migrations/0001_schema.sql. Regenerate
 * with `npx supabase gen types typescript` once a real Supabase project is
 * linked, and diff — do not assume these stay in sync automatically.
 *
 * `Json` matches what PostgREST can return for a jsonb column.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type PlayerAlignment = 'werewolf' | 'village' | 'neutral';
export type RoomStatus = 'lobby' | 'in_progress' | 'finished';
export type GamePhase = 'lobby' | 'night' | 'day' | 'voting' | 'finished';
export type NightActionType = 'eliminate' | 'investigate' | 'protect';
export type KillCause = 'night_elimination' | 'vote_elimination';
export type VoteTieRule = 'none' | 'random';

export type GameEventType =
  | 'player_joined'
  | 'player_left'
  | 'game_started'
  | 'night_started'
  | 'day_started'
  | 'voting_started'
  | 'player_eliminated'
  | 'night_result_public'
  | 'vote_result'
  | 'game_finished';

export type RoomRow = {
  id: string;
  room_code: string;
  host_user_id: string;
  status: RoomStatus;
  phase: GamePhase;
  round_number: number;
  max_players: number;
  phase_ends_at: string | null;
  settings: Json;
  last_activity_at: string;
  expires_at: string | null;
  state_version: number;
  transition_claim: string | null;
  transition_claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type RoomPlayerRow = {
  id: string;
  room_id: string;
  user_id: string;
  display_name: string;
  seat_number: number;
  is_alive: boolean;
  is_ready?: boolean;
  death_cause: KillCause | null;
  died_at: string | null;
  /** Unanswered prompt, e.g. `{ type: 'hunter_final_shot' }`. */
  prompt: Json | null;
  prompt_deadline_at: string | null;
  joined_at: string;
  last_seen_at: string;
}

export type PlayerSecretRow = {
  player_id: string;
  role_key: string;
  alignment: PlayerAlignment;
  private_state: Json;
  assigned_at: string;
}

export type RoomRoleConfigRow = {
  room_id: string;
  role_key: string;
  role_count: number;
  config: Json;
}

export type GameActionRow = {
  id: string;
  room_id: string;
  round_number: number;
  actor_player_id: string;
  action_type: NightActionType;
  target_player_id: string | null;
  payload: Json;
  created_at: string;
  updated_at: string;
}

export type GameVoteRow = {
  id: string;
  room_id: string;
  round_number: number;
  voter_player_id: string;
  target_player_id: string;
  created_at: string;
  updated_at: string;
}

export type GameEventRow = {
  id: number;
  room_id: string;
  event_type: GameEventType;
  public_payload: Json;
  round_number: number | null;
  created_at: string;
}

export type GameActionResultRow = {
  id: string;
  room_id: string;
  round_number: number;
  action_id: string;
  actor_player_id: string;
  result_type: string;
  result_payload: Json;
  created_at: string;
}

export type GameChatMessageRow = {
  id: string;
  room_id: string;
  round_number: number;
  author_player_id: string;
  message: string;
  created_at: string;
}

/**
 * Structural shape of the `Database` generic that `@supabase/supabase-js`
 * expects. The `Relationships` / `CompositeTypes` keys are required by the
 * client's type machinery — omitting them makes every `.from(...)` resolve to
 * `never` rather than failing loudly.
 */
export interface TableDefinition<Row, Insert = Partial<Row>, Update = Partial<Row>> {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
}

export interface Database {
  public: {
    Tables: {
      rooms: TableDefinition<RoomRow>;
      room_players: TableDefinition<RoomPlayerRow>;
      player_secrets: TableDefinition<PlayerSecretRow>;
      room_role_configs: TableDefinition<RoomRoleConfigRow>;
      game_actions: TableDefinition<GameActionRow>;
      game_votes: TableDefinition<GameVoteRow>;
      game_events: TableDefinition<GameEventRow>;
      game_action_results: TableDefinition<GameActionResultRow>;
      game_chat_messages: TableDefinition<GameChatMessageRow>;
    };
    // Empty schema sections must use the `[_ in never]: never` mapped form,
    // NOT `Record<string, never>`. The client computes
    // `Tables & Views`, so a `never`-valued index signature would intersect
    // every table type down to `never` and silently break every query.
    Views: {
      [_ in never]: never;
    };
    Functions: {
      create_room: {
        Args: { p_user_id: string; p_display_name: string; p_max_players?: number };
        Returns: Json;
      };
      join_room: {
        Args: { p_room_code: string; p_user_id: string; p_display_name: string };
        Returns: Json;
      };
      leave_room: { Args: { p_room_id: string; p_user_id: string }; Returns: Json };
      set_role_config: { Args: { p_room_id: string; p_user_id: string; p_entries: Json }; Returns: Json };
      set_room_settings: {
        Args: { p_room_id: string; p_user_id: string; p_phase_seconds: Json };
        Returns: Json;
      };
      start_game: {
        Args: {
          p_room_id: string;
          p_user_id: string;
          p_assignments: Json;
          p_night_seconds: number;
        };
        Returns: Json;
      };
      submit_night_action: {
        Args: {
          p_room_id: string;
          p_user_id: string;
          p_action_type: string;
          p_target_player_id: string;
        };
        Returns: Json;
      };
      cast_vote: {
        Args: { p_room_id: string; p_user_id: string; p_target_player_id: string };
        Returns: Json;
      };
      claim_phase_transition: {
        Args: {
          p_room_id: string;
          p_expected_version: number;
          p_expected_phase: string;
          p_claim_timeout_seconds?: number;
        };
        Returns: Json;
      };
      commit_phase_transition: {
        Args: {
          p_room_id: string;
          p_claim: string;
          p_next_phase: string;
          p_round_number: number;
          p_phase_seconds: number;
          p_eliminations: Json;
          p_events: Json;
        };
        Returns: Json;
      };
      finish_game: {
        Args: {
          p_room_id: string;
          p_claim: string;
          p_winner: string;
          p_winner_counts: Json;
          p_eliminations: Json;
        };
        Returns: Json;
      };
      release_phase_transition_claim: {
        Args: {
          p_room_id: string;
          p_claim: string;
        };
        Returns: Json;
      };
      consume_rate_limit: {
        Args: {
          p_bucket: string;
          p_key: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: Json;
      };
      run_cleanup: { Args: { p_batch_size?: number }; Returns: Json };
      tick_room: { Args: { p_room_id: string }; Returns: Json };
      apply_hunter_final_shot: { Args: { p_room_id: string; p_user_id: string; p_target_player_id: string }; Returns: { ok: boolean } };
      expire_pending_hunter_final_shots: { Args: { p_room_id?: string | null }; Returns: { ok: boolean; expired: number } };
      verify_player_credentials: {
        Args: { p_nickname: string; p_pin: string };
        Returns: Json;
      };
      register_player_credentials: {
        Args: { p_user_id: string; p_nickname: string; p_pin: string };
        Returns: Json;
      };
      get_system_health: {
        Args: Record<string, never>;
        Returns: Json;
      };
    };
    Enums: {
      player_alignment: PlayerAlignment;
      room_status: RoomStatus;
      game_phase: GamePhase;
      night_action_type: NightActionType;
      kill_cause: KillCause;
      vote_tie_rule: VoteTieRule;
      game_event_type: GameEventType;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
