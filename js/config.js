// Public configuration. These two values are PUBLIC by design (they ship to every
// browser). They are safe only because the database is locked down by Row Level
// Security (see supabase/schema.sql). NEVER put the service_role key, the
// Turnstile secret key or any API key in this file.
window.ENERGIX = {
  SUPABASE_URL: "https://irknzyvpugvnqhftjwwn.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlya256eXZwdWd2bnFoZnRqd3duIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5MjI3NjYsImV4cCI6MjEwODQ5ODc2Nn0.iIqfE1-c9NvAjjtZ1_OaQmmLjKhqhBhM5jIvgDr_ir0"
};
