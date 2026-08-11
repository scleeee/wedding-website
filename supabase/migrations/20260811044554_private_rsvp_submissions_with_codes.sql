-- Host-only RSVP reporting. The private schema is intentionally not exposed by
-- Supabase's Data API, and no API role receives access to this view.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on tables from public, anon, authenticated, service_role;

create view private.rsvp_submissions_with_codes
with (security_invoker = true, security_barrier = true)
as
select
  submission.id,
  submission.guest_group_id,
  admin.invite_code,
  submission.seat_number,
  submission.submitted_name,
  submission.attending,
  submission.dietary_requirements,
  submission.submitted_at,
  submission.updated_at
from public.rsvp_submissions as submission
join public.rsvp_invite_admin as admin
  on admin.id = submission.guest_group_id;

revoke all on table private.rsvp_submissions_with_codes
  from public, anon, authenticated, service_role;

comment on view private.rsvp_submissions_with_codes is
  'Host-only RSVP submission reporting with readable invite codes. The private schema is not exposed through the Data API.';
