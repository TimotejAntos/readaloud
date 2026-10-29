-- ReadAloud highlights (see docs/CLOUD-CONTRACT.md).
-- Adds only ra_* objects. Additive: nothing else in the project is touched.

-- ---------------------------------------------------------------- tables

-- One row per highlight. The exact place is a word range in the parsed
-- document (docs/{user}/{document}.json). text + prefix + suffix are kept too,
-- so a highlight can find its place again if a book is ever parsed anew.
-- chapter / page / paragraph are the human path, saved when it was made.
create table public.ra_highlights (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id  uuid not null references public.ra_documents (id) on delete cascade,
  start_word   int not null check (start_word >= 0),
  end_word     int not null,
  text         text not null,
  prefix       text not null default '',
  suffix       text not null default '',
  color        text not null,
  note         text not null default '',
  chapter      text not null default '',
  page         int,
  paragraph    int,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (end_word >= start_word)
);
comment on table public.ra_highlights is
  'ReadAloud highlights. Word range start_word..end_word in the parsed document; color = palette id (e.g. "blue") or "#rrggbb".';

-- One row per user: the highlight palette and what each color means.
-- palette = [{ "id": "blue", "hex": "#60a5fa", "label": "Love this" }, ...]
create table public.ra_user_settings (
  user_id     uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  palette     jsonb not null default '[]'::jsonb check (jsonb_typeof(palette) = 'array'),
  updated_at  timestamptz not null default now()
);
comment on table public.ra_user_settings is
  'ReadAloud per-user settings, synced across devices. palette = highlight colors and their 1-3 word meanings.';

create index ra_highlights_user_idx on public.ra_highlights (user_id, created_at desc);
create index ra_highlights_document_idx on public.ra_highlights (document_id, start_word);

create trigger ra_highlights_touch before update on public.ra_highlights
  for each row execute function public.ra_touch_updated_at();
create trigger ra_user_settings_touch before update on public.ra_user_settings
  for each row execute function public.ra_touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- A signed-in user sees and writes only their own rows.

alter table public.ra_highlights enable row level security;
alter table public.ra_user_settings enable row level security;

create policy ra_highlights_select on public.ra_highlights for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_highlights_insert on public.ra_highlights for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.ra_documents d
                          where d.id = document_id and d.user_id = (select auth.uid())));
create policy ra_highlights_update on public.ra_highlights for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ra_highlights_delete on public.ra_highlights for delete to authenticated
  using (user_id = (select auth.uid()));

create policy ra_user_settings_select on public.ra_user_settings for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_user_settings_insert on public.ra_user_settings for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ra_user_settings_update on public.ra_user_settings for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table public.ra_highlights, public.ra_user_settings;
