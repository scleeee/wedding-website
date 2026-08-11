-- Server-only export path for the Google Sheets sync. The token itself is never
-- stored: only its SHA-256 digest is retained in the non-exposed private schema.

create table private.google_sheet_sync_credentials (
  id boolean primary key default true check (id),
  token_digest text not null check (token_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

alter table private.google_sheet_sync_credentials enable row level security;
revoke all on table private.google_sheet_sync_credentials
  from public, anon, authenticated, service_role;

create or replace function public.export_rsvp_submissions_for_sheet(p_token text)
returns table (
  invite_code text,
  seat_number integer,
  submitted_name text,
  attending boolean,
  dietary_requirements text,
  submitted_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token is null or char_length(p_token) not between 32 and 256 then
    raise exception using
      errcode = '28000',
      message = 'INVALID_SHEET_SYNC_TOKEN';
  end if;

  if not exists (
    select 1
    from private.google_sheet_sync_credentials as credential
    where credential.token_digest = encode(extensions.digest(p_token, 'sha256'), 'hex')
  ) then
    raise exception using
      errcode = '28000',
      message = 'INVALID_SHEET_SYNC_TOKEN';
  end if;

  return query
  select
    submission.invite_code,
    submission.seat_number,
    submission.submitted_name,
    submission.attending,
    submission.dietary_requirements,
    submission.submitted_at,
    submission.updated_at
  from private.rsvp_submissions_with_codes as submission
  order by submission.invite_code, submission.seat_number;
end;
$$;

revoke execute on function public.export_rsvp_submissions_for_sheet(text)
  from public, anon, authenticated;
grant execute on function public.export_rsvp_submissions_for_sheet(text)
  to service_role;

comment on function public.export_rsvp_submissions_for_sheet(text) is
  'Server-only, token-validated export of current RSVP submissions for the owner’s Google Sheet. Returns no internal IDs.';
