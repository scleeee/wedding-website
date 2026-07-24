// This is a public browser endpoint. All privileged credentials and rate-limit
// credentials belong in Supabase Edge Function secrets, never in this file.
window.WEDDING_CONFIG = Object.freeze({
  rsvpEndpoint: 'https://ehyoweasqwahqpdzftgt.supabase.co/functions/v1/rsvp'
});
