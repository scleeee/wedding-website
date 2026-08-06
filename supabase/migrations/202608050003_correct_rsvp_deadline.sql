-- Keep the signed-in RSVP experience aligned with the date shown on the site.
-- The deadline is the end of September 14 in Philippine time.
update public.invites
set rsvp_deadline = '2026-09-14 23:59:59+08'::timestamptz;
