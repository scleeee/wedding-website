-- The RSVP flow is intentionally anonymous and invitation-code based.
-- Signed-in users receive no broader or duplicate execution path.
revoke execute on function public.lookup_rsvp(text) from authenticated;
revoke execute on function public.submit_rsvp(text, jsonb) from authenticated;

-- Existing trigger helper: pin the path even though it is no longer API-callable.
alter function public.set_updated_at() set search_path = '';
