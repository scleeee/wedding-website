-- Only trusted server-side callers may execute the RSVP RPCs. The public
-- Edge Function uses the service role after it has applied rate limits.
revoke execute on function public.lookup_rsvp(text) from public, anon, authenticated;
revoke execute on function public.submit_rsvp(text, jsonb) from public, anon, authenticated;

grant execute on function public.lookup_rsvp(text) to service_role;
grant execute on function public.submit_rsvp(text, jsonb) to service_role;

-- Friendly codes are stored in normalized form. Existing 30-character codes
-- continue to satisfy this constraint, while shorter alphanumeric codes can be
-- introduced without pretending they are high-entropy credentials.
alter table public.invites
  drop constraint if exists invites_code_format_check;
alter table public.invites
  add constraint invites_code_format_check
    check (char_length(code) between 1 and 128 and code ~ '^[A-Z0-9]+$');

comment on column public.invites.code is
  'Friendly RSVP identifier. It is guessable and must only be checked through the rate-limited RSVP Edge Function.';
comment on function public.lookup_rsvp(text) is
  'Trusted-server RSVP lookup. Not executable by anon or authenticated clients.';
comment on function public.submit_rsvp(text, jsonb) is
  'Trusted-server atomic RSVP update. Not executable by anon or authenticated clients.';
