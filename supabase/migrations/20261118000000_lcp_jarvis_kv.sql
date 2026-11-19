-- LCP JARVIS memory store. Used when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in Netlify Functions.
-- Each row is one JSON document (chat, chat index, agent memory, company memory, bots, custom instructions).
-- etag changes on every write so the functions can do compare-and-swap updates.
create table if not exists public.lcp_jarvis_kv (
  key text primary key check (char_length(key) between 1 and 200),
  data jsonb not null,
  etag uuid not null,
  updated_at timestamptz not null default now()
);
create index if not exists lcp_jarvis_kv_updated_at on public.lcp_jarvis_kv (updated_at desc);

-- Only the service role (server side) may read or write. No policies means anon and authenticated keys get nothing.
alter table public.lcp_jarvis_kv enable row level security;
revoke all on public.lcp_jarvis_kv from anon, authenticated;
