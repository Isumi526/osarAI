-- つながり(顧客)に区分を追加(議事録要望・「つながり(既定)/顧客/パートナー」)。
-- 将来の区分追加を考慮しCHECK制約は設けず自由記述(text)にする(category/mode列と同じ方針)。
-- 既定は「つながり」。既存行はNULL(=未設定)のまま扱い、表示側で既定にフォールバックする。
alter table customers add column relation_type text;
