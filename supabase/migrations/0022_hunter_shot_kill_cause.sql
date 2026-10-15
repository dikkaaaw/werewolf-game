-- Upstream Hunter kills use KillMthd.HunterShot, distinct from a night wolf
-- kill and a village vote. Preserve that distinction in public snapshots.
alter type public.kill_cause add value if not exists 'hunter_shot';
