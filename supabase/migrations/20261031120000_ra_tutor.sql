-- ReadAloud tutor (see docs/TUTOR.md).
-- Adds only ra_* objects. Additive: nothing else in the project is touched.
-- Needs the pgvector extension in schema "extensions" (on by default in Supabase).

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------- tables

-- One row per piece of a book (about 200 words, cut at paragraph edges).
-- start_word..end_word is the exact place, so a source can open the book there.
-- embedding = gte-small (384 numbers, normalized), made by the ra-tutor-index function.
create table public.ra_chunks (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id  uuid not null references public.ra_documents (id) on delete cascade,
  chunk_no     int not null check (chunk_no >= 0),
  start_word   int not null check (start_word >= 0),
  end_word     int not null,
  page         int,
  page_end     int,
  chapter      text not null default '',
  text         text not null,
  embedding    extensions.vector(384),
  fts          tsvector generated always as (to_tsvector('english', chapter || ' ' || text)) stored,
  created_at   timestamptz not null default now(),
  unique (document_id, chunk_no),
  check (end_word >= start_word)
);
comment on table public.ra_chunks is
  'ReadAloud tutor: book pieces for search. Word range start_word..end_word in the parsed document.';

-- A chat with the tutor. document_id = null means "all my books".
create table public.ra_tutor_threads (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id  uuid references public.ra_documents (id) on delete cascade,
  title        text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One question or answer. For answers, parts = [{ text, cites: [n] }] and
-- sources = [{ n, chunk_id, document_id, title, chapter, page, start_word, end_word, quote }].
create table public.ra_tutor_messages (
  id           uuid primary key default gen_random_uuid(),
  thread_id    uuid not null references public.ra_tutor_threads (id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role         text not null check (role in ('user', 'assistant')),
  content      text not null,
  parts        jsonb not null default '[]'::jsonb,
  sources      jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

-- The learner profile: how the tutor should teach this user.
alter table public.ra_user_settings add column if not exists tutor jsonb not null default '{}'::jsonb;

create index ra_chunks_doc_idx on public.ra_chunks (user_id, document_id, chunk_no);
create index ra_chunks_embedding_idx on public.ra_chunks using hnsw (embedding extensions.vector_ip_ops);
create index ra_chunks_fts_idx on public.ra_chunks using gin (fts);
create index ra_tutor_threads_user_idx on public.ra_tutor_threads (user_id, updated_at desc);
create index ra_tutor_messages_thread_idx on public.ra_tutor_messages (thread_id, created_at);

create trigger ra_tutor_threads_touch before update on public.ra_tutor_threads
  for each row execute function public.ra_touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- A signed-in user sees and writes only their own rows. The tutor functions
-- act with the user's own token, so these rules apply to them too.

alter table public.ra_chunks enable row level security;
alter table public.ra_tutor_threads enable row level security;
alter table public.ra_tutor_messages enable row level security;

create policy ra_chunks_select on public.ra_chunks for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_chunks_insert on public.ra_chunks for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.ra_documents d
                          where d.id = document_id and d.user_id = (select auth.uid())));
create policy ra_chunks_update on public.ra_chunks for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ra_chunks_delete on public.ra_chunks for delete to authenticated
  using (user_id = (select auth.uid()));

create policy ra_tutor_threads_select on public.ra_tutor_threads for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_tutor_threads_insert on public.ra_tutor_threads for insert to authenticated
  with check (user_id = (select auth.uid())
              and (document_id is null or exists (select 1 from public.ra_documents d
                                                  where d.id = document_id and d.user_id = (select auth.uid()))));
create policy ra_tutor_threads_update on public.ra_tutor_threads for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy ra_tutor_threads_delete on public.ra_tutor_threads for delete to authenticated
  using (user_id = (select auth.uid()));

create policy ra_tutor_messages_select on public.ra_tutor_messages for select to authenticated
  using (user_id = (select auth.uid()));
create policy ra_tutor_messages_insert on public.ra_tutor_messages for insert to authenticated
  with check (user_id = (select auth.uid())
              and exists (select 1 from public.ra_tutor_threads t
                          where t.id = thread_id and t.user_id = (select auth.uid())));
create policy ra_tutor_messages_delete on public.ra_tutor_messages for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- search
-- Hybrid search: by meaning (embedding) and by words (full text), merged with
-- reciprocal rank fusion. Runs as the caller, so RLS keeps it to their books.
-- doc_ids = null searches all the user's books. near_doc/near_word give a small
-- bonus to pieces near where the reader is.

create function public.ra_search_chunks(
  query_embedding extensions.vector(384),
  query_text text,
  doc_ids uuid[] default null,
  match_count int default 10,
  near_doc uuid default null,
  near_word int default null
)
returns table (id uuid, document_id uuid, chunk_no int, score double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select websearch_to_tsquery('english',
             regexp_replace(trim(regexp_replace(coalesce(query_text, ''), '[^[:alnum:][:space:]]', ' ', 'g')), '\s+', ' or ', 'g')) as ts
  ),
  sem as (
    select c.id, row_number() over (order by c.embedding operator(extensions.<#>) query_embedding) as r
    from public.ra_chunks c
    where c.user_id = (select auth.uid())
      and (doc_ids is null or c.document_id = any (doc_ids))
      and c.embedding is not null
    order by c.embedding operator(extensions.<#>) query_embedding
    limit 40
  ),
  kw as (
    select c.id, row_number() over (order by ts_rank_cd(c.fts, q.ts) desc) as r
    from public.ra_chunks c, q
    where c.user_id = (select auth.uid())
      and (doc_ids is null or c.document_id = any (doc_ids))
      and c.fts @@ q.ts
    order by ts_rank_cd(c.fts, q.ts) desc
    limit 40
  )
  select c.id, c.document_id, c.chunk_no,
         coalesce(1.0 / (60 + sem.r), 0)
       + coalesce(1.0 / (60 + kw.r), 0)
       + case when near_doc is not null and c.document_id = near_doc
                   and near_word between c.start_word - 1500 and c.end_word + 1500
              then 0.005 else 0 end as score
  from public.ra_chunks c
  left join sem on sem.id = c.id
  left join kw on kw.id = c.id
  where sem.id is not null or kw.id is not null
  order by score desc
  limit least(match_count, 40);
$$;

revoke execute on function public.ra_search_chunks from public, anon;
grant execute on function public.ra_search_chunks to authenticated;
