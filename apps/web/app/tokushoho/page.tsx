// 特定商取引法に基づく表記（2026-09-28 下書き）。Web で月額課金（通信販売）を行うため必須。
// 【要記入】が残っている間は本番では公開しない（lib/legal）。公開前に専門家の確認を推奨。
import { notFound } from 'next/navigation';
import { PLANS } from '@osarai/shared';
import { LEGAL, hasPlaceholder, isProduction } from '@/lib/legal';

const SELLER = LEGAL.operator;
const MANAGER = LEGAL.manager;
const EMAIL = LEGAL.email;
const ADDRESS = LEGAL.address;
const PHONE = LEGAL.phone;
const TAX = LEGAL.priceTax;

// 公開している有料プラン（Light/Standard/Pro）。価格はプラン定義から出す（定義と表記がずれないように）
const PAID = (['light', 'standard', 'pro'] as const).map((id) => PLANS[id]);

export default function TokushohoPage() {
  if (isProduction() && hasPlaceholder(SELLER, MANAGER, EMAIL, ADDRESS, PHONE, TAX)) notFound();
  const rows: [string, React.ReactNode][] = [
    ['販売事業者', SELLER],
    ['運営統括責任者', MANAGER],
    ['所在地', ADDRESS],
    ['電話番号', PHONE],
    ['メールアドレス', EMAIL],
    [
      '販売価格',
      <>
        {PAID.map((p) => (
          <div key={p.id}>
            {p.name}：月額 ¥{p.listPrice.toLocaleString()}（{TAX}）
          </div>
        ))}
        <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>割引コードをお使いの場合は、お申し込み画面に表示される金額となります。</div>
      </>,
    ],
    ['商品代金以外の必要料金', 'インターネット接続に必要な通信料はお客様のご負担となります。'],
    ['お支払い方法', 'クレジットカード（Apple Pay・Google Pay を含む）。決済は Stripe を通じて行います。'],
    ['お支払い時期', 'お申し込みから14日間は無料です。無料期間の終了日に初回の料金をお支払いいただき、以降は毎月同じ日に自動で更新・お支払いとなります。'],
    ['サービスの提供時期', 'お申し込みの手続きが完了した時点から、すぐにご利用いただけます。'],
    ['解約・キャンセル', 'Web のマイページ（お支払い管理）から、いつでも解約できます。無料期間中に解約された場合、料金は発生しません。解約後も、その時点で支払い済みの期間の終了日まではご利用いただけます。'],
    ['返金', 'サービスの性質上、お支払い済みの料金の返金はいたしません。'],
    ['動作環境', 'パソコン：Google Chrome または Microsoft Edge の最新版（会議の録音に必要）／スマートフォン：iOS・Android の最新のブラウザ'],
  ];
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px', lineHeight: 1.8 }}>
      <h1>特定商取引法に基づく表記</h1>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 15 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k} style={{ borderTop: '1px solid var(--color-border)' }}>
              <th style={{ textAlign: 'left', verticalAlign: 'top', padding: '12px 12px 12px 0', width: '32%', whiteSpace: 'nowrap' }}>{k}</th>
              <td style={{ padding: '12px 0' }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
