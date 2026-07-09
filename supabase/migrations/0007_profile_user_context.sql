-- ユーザー自身のプロフィール（年齢/性別/経歴/仕事/扱い商品/目標）。
-- AI戦略相談(/api/advice)のコンテキストに含めるための自由記述JSONB。
-- RLSは既存の profiles_select/profiles_update をそのまま適用（追加カラムのみ・ポリシー変更不要）。
alter table profiles add column user_profile jsonb not null default '{}';
