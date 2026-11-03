-- つながり・自分の情報を「要点/ニーズ/次アクション/custom_fields」に分けず、自由記述のメモ1本で持つ（2026-11-03 人判断「進める」）。
-- 機械が使う項目（name / last_met_at / temperature / relation_type / schedules / tasks / wants_to_meet）は構造のまま残す。
-- 既存の列は消さない・書き換えない（旧データの読み取り経路はフォールバックとして残す）。新しい列を足し、
-- 同じ migration の中で旧項目から読みやすい日本語の行に畳んで埋める（新しい列が null の行だけ）。
--
--   customers.profile_notes  … その人についてのメモ（旧 needs ＋ custom_fields の age/gender/products 等）
--   interactions.summary     … その回の要約（旧 ai_summary の points/needs/next_actions）。議事録は ai_summary.minutes のまま
--   profiles.profile_text    … 自分についてのメモ（旧 user_profile.notes）
--
-- wants_to_meet（Phase2 マッチングの入力）は custom_fields.wants_to_meet に構造のまま残すため、メモには畳まない。

alter table customers    add column if not exists profile_notes text;
alter table interactions add column if not exists summary text;
alter table profiles     add column if not exists profile_text text;

-- ========== 埋め戻し ==========

-- つながり: 「ニーズ: …」「年齢: …」「性別: …」「扱っている商品: …」＋その他のキー（キー名: 値）
update customers c
set profile_notes = nullif(concat_ws(E'\n',
  case when coalesce(trim(c.needs), '') <> '' then 'ニーズ: ' || trim(c.needs) end,
  case when jsonb_typeof(c.custom_fields) = 'object' and coalesce(trim(c.custom_fields->>'age'), '') <> ''
    then '年齢: ' || trim(c.custom_fields->>'age') end,
  case when jsonb_typeof(c.custom_fields) = 'object' and coalesce(trim(c.custom_fields->>'gender'), '') <> ''
    then '性別: ' || trim(c.custom_fields->>'gender') end,
  case when jsonb_typeof(c.custom_fields) = 'object' then
    '扱っている商品: ' || (
      case jsonb_typeof(c.custom_fields->'products')
        when 'array' then (
          select string_agg(trim(e), '、')
          from jsonb_array_elements_text(c.custom_fields->'products') e
          where trim(e) <> ''
        )
        when 'string' then nullif(trim(c.custom_fields->>'products'), '')
      end
    )
  end,
  case when jsonb_typeof(c.custom_fields) = 'object' then (
    select string_agg(t.k || ': ' || t.v, E'\n' order by t.k)
    from (
      select kv.key as k,
        trim(case jsonb_typeof(kv.value)
          when 'array' then (select string_agg(x, '、') from jsonb_array_elements_text(kv.value) x)
          when 'string' then kv.value #>> '{}'
          when 'null' then null
          else kv.value::text
        end) as v
      from jsonb_each(c.custom_fields) kv
      where kv.key not in ('age', 'gender', 'products', 'wants_to_meet')
    ) t
    where coalesce(t.v, '') <> ''
  ) end
), '')
where c.profile_notes is null;

-- 対応履歴: 要点は1行ずつ、続けて「ニーズ: a / b」「次アクション: x / y」
update interactions i
set summary = nullif(concat_ws(E'\n',
  case when jsonb_typeof(i.ai_summary->'points') = 'array' then (
    select string_agg(trim(e), E'\n')
    from jsonb_array_elements_text(i.ai_summary->'points') e
    where trim(e) <> ''
  ) end,
  case when jsonb_typeof(i.ai_summary->'needs') = 'array' then 'ニーズ: ' || (
    select string_agg(trim(e), ' / ')
    from jsonb_array_elements_text(i.ai_summary->'needs') e
    where trim(e) <> ''
  ) end,
  case when jsonb_typeof(i.ai_summary->'next_actions') = 'array' then '次アクション: ' || (
    select string_agg(trim(e), ' / ')
    from jsonb_array_elements_text(i.ai_summary->'next_actions') e
    where trim(e) <> ''
  ) end
), '')
where i.summary is null and jsonb_typeof(i.ai_summary) = 'object';

-- 自分: 蓄積した気づき（notes）を1行ずつ
update profiles p
set profile_text = (
  select string_agg(trim(n), E'\n')
  from jsonb_array_elements_text(p.user_profile->'notes') n
  where trim(n) <> ''
)
where p.profile_text is null and jsonb_typeof(p.user_profile->'notes') = 'array';

-- ========== 自分のメモへの追記（アトミック） ==========
-- 0011/0013 と同じく単一の UPDATE で追記し、読み取りと書き込みの間の競合で失われないようにする。
-- security invoker = profiles_update ポリシー（id = auth.uid()）がそのまま効く。自分の行しか更新できない。
create or replace function append_profile_text(addition text) returns void
language sql security invoker set search_path = public, pg_temp as $$
  update profiles
  set profile_text = case
    when coalesce(trim(profile_text), '') = '' then trim(addition)
    else profile_text || E'\n' || trim(addition)
  end
  where id = auth.uid() and coalesce(trim(addition), '') <> '';
$$;

-- ========== つながり統合（0030）にメモを追加 ==========
-- 関数本体は 0030 と同一で、profile_notes の寄せ方だけ追加（統合元のメモが消えないように改行でつなぐ）。
create or replace function merge_customers(source_id uuid, target_id uuid)
returns void
language plpgsql
security invoker  -- RLSを効かせる（自分のつながり同士でしか統合できない）
set search_path = public, pg_temp
as $$
declare
  src customers%rowtype;
  tgt customers%rowtype;
begin
  if source_id = target_id then
    raise exception '同じつながりは統合できません';
  end if;

  select * into src from customers where id = source_id;
  select * into tgt from customers where id = target_id;
  if src.id is null or tgt.id is null then
    raise exception '対象のつながりが見つかりません';
  end if;
  if src.owner_id <> tgt.owner_id or src.org_id <> tgt.org_id then
    raise exception '所有者または組織が異なるつながりは統合できません';
  end if;

  -- 統合先に情報を寄せる。統合先が空の項目だけ統合元で埋める（上書きしない）。
  update customers set
    needs = case
      when coalesce(tgt.needs, '') = '' then src.needs
      when coalesce(src.needs, '') = '' or tgt.needs = src.needs then tgt.needs
      else tgt.needs || ' / ' || src.needs
    end,
    profile_notes = case
      when coalesce(tgt.profile_notes, '') = '' then src.profile_notes
      when coalesce(src.profile_notes, '') = '' or tgt.profile_notes = src.profile_notes then tgt.profile_notes
      else tgt.profile_notes || E'\n' || src.profile_notes
    end,
    custom_fields = coalesce(src.custom_fields, '{}'::jsonb) || coalesce(tgt.custom_fields, '{}'::jsonb),
    relation_type = coalesce(tgt.relation_type, src.relation_type),
    last_met_at = greatest(coalesce(tgt.last_met_at, src.last_met_at), coalesce(src.last_met_at, tgt.last_met_at)),
    updated_at = now()
  where id = target_id;

  -- customer_id を持つ全テーブルを付け替える（新しいテーブルを足したらここにも追加すること）
  update interactions    set customer_id = target_id where customer_id = source_id;
  update schedules       set customer_id = target_id where customer_id = source_id;
  update tasks           set customer_id = target_id where customer_id = source_id;
  update osarai_sessions set customer_id = target_id where customer_id = source_id;
  update ai_chats        set customer_id = target_id where customer_id = source_id;
  -- 会議録音（0028）。統合元が消えると on delete set null で相手リンクが失われるため付け替える。
  update meeting_recordings set customer_id = target_id where customer_id = source_id;

  delete from customers where id = source_id;
end;
$$;
