---
title: Side-effects must not pre-commit status
severity: high
paths:
  - supabase/functions/**
---
メール送信・プッシュ通知（APNS/FCM）・Stripe課金等の外部副作用は、成功を確認するまでレコードを「送信済／課金済／完了」にしないこと。
成功前に status を進める・送信/課金失敗を握り潰す（エラーを無視して成功扱いにする）実装を high として指摘する。
