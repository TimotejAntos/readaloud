-- ReadAloud cloud base (see docs/CLOUD-CONTRACT.md).
-- Adds only ra_* objects and the private bucket "readaloud".
-- Additive only: other tables, buckets and auth settings in the project are not touched.

-- ---------------------------------------------------------------- tables

create table public.ra_documents (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null,
  file_name   text,
  bytes       bigint,
  pages       int,
  words       int,
  pdf_path    text,
  doc_path    text,
  position    jsonb not null default '{"word":0}'::jsonb,
  created_at  timestamptz not null default now(),
  opened_at   timestamptz,
  updated_at  timestamptz not null default now()
);
comment on table public.ra_documents is
  'ReadAloud library. One row per PDF. position = {"word": n, "device": id, "at": iso}, synced live between devices.';

create table public.ra_render_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id  uuid references public.ra_documents (id) on delete cascade,
  engine       text not null check (engine in ('pc', 'kokoro_api', 'modal')),
  voice        text not null,
  items        jsonb not null check (jsonb_typeof(items) = 'array'),
  status       text not null default 'queued' check (status in ('queued', 'working', 'done', 'error')),
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
comment on table public.ra_render_jobs is
  'ReadAloud voice work. The phone inserts a job with sentence texts; an engine renders them into ra_audio.';

create table public.ra_audio (
  key          text primary key,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  engine       text not null,
  voice        text not null,
  audio_path   text not null,
  format       text not null default 'mp3',
  duration_ms  int,
  marks        jsonb not null,
  created_at   timestamptz not null default now()
);
comment on table public.ra_audio is
  'ReadAloud audio cache. key = sha1(engine|voice|text). marks = speech marks, one chunk per word.';

create index ra_documents_user_idx on public.ra_documents (user_id, opened_at desc);
create index ra_render_jobs_user_idx on public.ra_render_jobs (user_id);
create index ra_render_jobs_document_idx on public.ra_render_jobs (document_id);
create index ra_render_jobs_queue_idx on public.ra_render_jobs (engine, created_at) where status = 'queued';
create index ra_audio_user_idx on public.ra_audio (user_id);

-- updated_at stays honest without trusting the client.
create function public.ra_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger ra_documents_touch before update on public.ra_documents
  for each row execute function public.ra_touch_updated_at();
create trigger ra_render_jobs_touch before update on public.ra_render_jobs
  for each row execute function public.ra_touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- A signed-in user sees and writes only their own rows.
-- Engines write with the service role, which bypasses RLS.

alter table public.ra_documents enable row level security;
alter table public.ra_render_jobs enable row level security;
alter table public.ra_audio enable row level security;

create policy ra_documents_select on public.ra_documents for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_documents_insert on public.ra_documents for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy ra_documents_update on public.ra_documents for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ra_documents_delete on public.ra_documents for delete to authenticated
  using (user_id = (select auth.uid()));

create policy ra_render_jobs_select on public.ra_render_jobs for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_render_jobs_insert on public.ra_render_jobs for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'queued');
create policy ra_render_jobs_delete on public.ra_render_jobs for delete to authenticated
  using (user_id = (select auth.uid()));

-- The phone only reads audio rows (and may clear its own). Engines insert them.
create policy ra_audio_select on public.ra_audio for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_audio_delete on public.ra_audio for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- Realtime

alter publication supabase_realtime add table public.ra_documents, public.ra_render_jobs, public.ra_audio;

-- ---------------------------------------------------------------- Storage
-- pdfs/{user_id}/{document_id}.pdf
-- docs/{user_id}/{document_id}.json
-- audio/{user_id}/{engine}/{voice}/{key}.mp3
-- The second folder is always the owner's id.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('readaloud', 'readaloud', false, 52428800,
        array['application/pdf', 'application/json', 'audio/mpeg'])
on conflict (id) do nothing;

create policy ra_storage_select on storage.objects for select to authenticated
  using (bucket_id = 'readaloud' and (storage.foldername(name))[2] = (select auth.uid())::text);
create policy ra_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'readaloud'
              and (storage.foldername(name))[1] in ('pdfs', 'docs')
              and (storage.foldername(name))[2] = (select auth.uid())::text);
create policy ra_storage_update on storage.objects for update to authenticated
  using (bucket_id = 'readaloud'
         and (storage.foldername(name))[1] in ('pdfs', 'docs')
         and (storage.foldername(name))[2] = (select auth.uid())::text)
  with check (bucket_id = 'readaloud'
              and (storage.foldername(name))[1] in ('pdfs', 'docs')
              and (storage.foldername(name))[2] = (select auth.uid())::text);
create policy ra_storage_delete on storage.objects for delete to authenticated
  using (bucket_id = 'readaloud' and (storage.foldername(name))[2] = (select auth.uid())::text);
