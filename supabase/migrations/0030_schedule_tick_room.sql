-- 0030_schedule_tick_room.sql
--
-- Hosted Supabase scheduler for rooms with no browser traffic.
--
-- pg_cron runs tick_room directly every five seconds. tick_room already owns
-- locking and idempotency, so this introduces no second concurrency protocol.
-- A bare local Postgres used by unit/integration tests usually does not ship
-- pg_cron; in that environment the migration intentionally does nothing.

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    execute 'create extension if not exists pg_cron with schema pg_catalog';

    execute $schedule$
      select cron.schedule(
        'werewolf-advance-due-rooms',
        '5 seconds',
        $job$
          select public.tick_room(due.id)
          from (
            select id
            from public.rooms
            where status = 'in_progress'
              and phase_ends_at <= now()
            order by phase_ends_at asc
            limit 200
          ) due;
        $job$
      );
    $schedule$;
  end if;
end;
$$;
