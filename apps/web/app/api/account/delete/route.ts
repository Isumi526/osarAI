// 退会（アカウント削除）（2026-09-28・人判断: 窓口への連絡ではなくアプリ内で退会できるようにする）。
// 順番が大事: ①契約を止める（課金が続いたままデータだけ消える、を防ぐ）→ ②録音音声（Storage）→
// ③アプリのデータ（delete_account_data）→ ④ログイン情報（auth.users）。途中で失敗したらそこで止める。
// 退会は即時で、支払い済み期間の返金はしない（特定商取引法に基づく表記・利用規約と同じ）。
import { NextResponse } from 'next/server';
import { authedFromRequest, corsPreflight, CORS_HEADERS } from '@/lib/api-auth';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { RECORDINGS_BUCKET } from '@/lib/recordings-bucket';
import { getStripe } from '@/lib/stripe';

export const runtime = 'nodejs';
export const maxDuration = 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const ctx = await authedFromRequest(req);
  if (!ctx) return json({ error: 'unauthenticated' }, 401);
  const { user } = ctx;
  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  // 誤操作防止: 画面側で「退会する」を確認した時だけ送る合言葉
  if (body.confirm !== 'DELETE_MY_ACCOUNT') return json({ error: 'confirmation_required' }, 400);

  const admin = createServiceRoleClient();

  // 組織の管理者（リーダー・代理店）は、チームの商品リストや紹介コードの持ち主なので自分では消さない
  const { data: profile } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
  if (profile && profile.role !== 'member') {
    return json({ error: 'managed_account', message: '管理者のアカウントは、お問い合わせから退会の手続きをお願いします。' }, 409);
  }

  // ① 契約を止める（Stripe）。まだ課金が続く状態でデータだけ消すことを避けるため、失敗したら中止する
  const { data: sub } = await admin.from('subscriptions').select('stripe_subscription_id, status').eq('user_id', user.id).maybeSingle();
  if (sub?.stripe_subscription_id && sub.status !== 'canceled') {
    try {
      await getStripe().subscriptions.cancel(sub.stripe_subscription_id);
    } catch (e) {
      const code = (e as { code?: string }).code;
      // 既に Stripe 側で消えている場合は続行してよい
      if (code !== 'resource_missing') return json({ error: 'stripe_cancel_failed', detail: String(e) }, 502);
    }
  }

  // ② 録音音声（Storage の recordings/<userId>/ 以下）
  try {
    const prefixes = [`${user.id}`, `${user.id}/meetings`];
    for (const prefix of prefixes) {
      for (;;) {
        const { data: files } = await admin.storage.from(RECORDINGS_BUCKET).list(prefix, { limit: 100 });
        const paths = (files ?? []).filter((f) => f.id).map((f) => `${prefix}/${f.name}`);
        if (paths.length === 0) break;
        const { error } = await admin.storage.from(RECORDINGS_BUCKET).remove(paths);
        if (error) throw error;
      }
    }
  } catch (e) {
    return json({ error: 'storage_delete_failed', detail: String(e) }, 500);
  }

  // ③ アプリのデータ（1トランザクション）
  const { error: dataErr } = await admin.rpc('delete_account_data', { p_user: user.id });
  if (dataErr) return json({ error: 'data_delete_failed', detail: dataErr.message }, 500);

  // ④ ログイン情報（profiles は CASCADE で消える）
  const { error: authErr } = await admin.auth.admin.deleteUser(user.id);
  if (authErr) return json({ error: 'auth_delete_failed', detail: authErr.message }, 500);

  return json({ ok: true }, 200);
}

function json(payload: unknown, status: number) {
  return NextResponse.json(payload, { status, headers: CORS_HEADERS });
}
