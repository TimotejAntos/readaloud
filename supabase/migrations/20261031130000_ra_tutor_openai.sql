-- ReadAloud tutor: search numbers now come from OpenAI text-embedding-3-small
-- (1536 numbers) instead of Supabase's gte-small (384). Old numbers are cleared;
-- the app makes them again the next time each book is opened.

drop function if exists public.ra_search_chunks(extensions.vector, text, uuid[], int, uuid, int);
drop index if exists public.ra_chunks_embedding_idx;
update public.ra_chunks set embedding = null;
alter table public.ra_chunks alter column embedding type extensions.vector(1536);
create index ra_chunks_embedding_idx on public.ra_chunks using hnsw (embedding extensions.vector_ip_ops);
comment on column public.ra_chunks.embedding is 'OpenAI text-embedding-3-small (1536 numbers, normalized), made by ra-tutor-index.';

create function public.ra_search_chunks(
  query_embedding extensions.vector(1536),
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
