// プライバシーポリシー（2026-09-28 下書き）。録音した音声・文字起こしを外部の AI サービスで
// 処理すること、会話の相手（第三者）の個人情報を扱うことを明示する。
// 【要記入】が残っている間は本番では公開しない（lib/legal）。公開前に専門家の確認を推奨。
import { notFound } from 'next/navigation';
import { LEGAL, hasPlaceholder, isProduction } from '@/lib/legal';

const OPERATOR = LEGAL.operator;
const CONTACT = LEGAL.email;
const ENACTED = LEGAL.privacyEnacted;
const GEMINI_TRAINING = LEGAL.geminiTraining;
const AUDIO_RETENTION = LEGAL.audioRetention;

export default function PrivacyPage() {
  if (isProduction() && hasPlaceholder(OPERATOR, CONTACT, ENACTED, GEMINI_TRAINING, AUDIO_RETENTION)) notFound();
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px', lineHeight: 1.8 }}>
      <h1>プライバシーポリシー</h1>
      <p>
        {OPERATOR}（以下「運営者」）は、osarAI（以下「本サービス」）における個人情報の取り扱いについて、以下のとおり定めます。
      </p>

      <h2>1. 取得する情報</h2>
      <ul>
        <li>アカウント情報：メールアドレス、お名前（表示名）、プロフィールとしてご入力いただいた情報</li>
        <li>
          ご利用者が記録する情報：会議の録音音声、その文字起こし、AI が作成した議事録・予定・TODO、会話の相手の情報（氏名・話した内容・つながりたい人など）
        </li>
        <li>決済に関する情報：プラン・契約状況（クレジットカード番号は決済代行会社が管理し、運営者は保持しません）</li>
        <li>利用状況の情報：ご利用の端末・ブラウザの種類、アクセス日時、通知を送るための端末の識別子</li>
      </ul>

      <h2>2. 利用目的</h2>
      <ul>
        <li>本サービスの提供（文字起こし、議事録・予定・TODO・相手の情報の作成と保存、AI への相談、通知）</li>
        <li>料金の請求、本人確認、お問い合わせへの対応</li>
        <li>不正利用の防止、障害の調査、本サービスの改善</li>
        <li>利用規約の改定や重要なお知らせのご連絡</li>
      </ul>

      <h2>3. 会話の相手の情報について</h2>
      <p>
        本サービスには、ご利用者が録音した会話の相手の情報が記録されます。ご利用者は、録音の前に相手の了承を得たうえで、
        これらの情報を個人情報保護法その他の法令に従って取り扱うものとします。運営者は、これらの情報をご利用者へのサービス提供以外の目的で利用しません。
      </p>

      <h2>4. 外部サービスへの送信（業務の委託）</h2>
      <p>本サービスの提供のため、以下の事業者のサービスに情報を送信して処理します。送信先のサーバーは日本国外（米国など）にある場合があります。</p>
      <ul>
        <li>Google LLC（Gemini API）：録音音声の文字起こし、議事録・予定・TODO の作成、AI への相談。{GEMINI_TRAINING}</li>
        <li>Supabase Inc.：アカウント情報・記録した情報・録音音声の保存</li>
        <li>Vercel Inc.：本サービスの配信</li>
        <li>Stripe, Inc.：決済</li>
        <li>Google LLC（Firebase Cloud Messaging）：プッシュ通知の配信</li>
      </ul>
      <p>運営者は、これらの事業者を選定し、必要かつ適切な監督を行います。法令に基づく場合を除き、上記以外の第三者に個人情報を提供しません。</p>

      <h2>5. 保存期間と削除</h2>
      <ul>
        <li>{AUDIO_RETENTION}</li>
        <li>文字起こし・議事録・予定・TODO・相手の情報は、ご利用者が削除するまで、または退会後に運営者が削除するまで保存します。</li>
        <li>退会・データの削除をご希望の場合は、下記の窓口までご連絡ください。</li>
      </ul>

      <h2>6. 安全管理</h2>
      <p>
        記録した情報は、ご利用者ご本人のみが閲覧できるようアクセスを制限し、通信は暗号化して扱います。
        組織でご利用の場合、組織の管理者（リーダー）が、利用規約に定める範囲で所属メンバーの記録を閲覧できることがあります。
      </p>

      <h2>7. 開示・訂正・削除などのご請求</h2>
      <p>ご本人から保有個人データの開示・訂正・利用停止・削除のご請求があった場合は、ご本人であることを確認のうえ、法令に従って対応します。</p>

      <h2>8. お問い合わせ窓口</h2>
      <p>{CONTACT}</p>

      <h2>9. 改定</h2>
      <p>本ポリシーを改定する場合は、改定内容と施行日を本サービス上でお知らせします。</p>

      <p style={{ marginTop: 32, color: 'var(--color-text-muted)', fontSize: 14 }}>制定日：{ENACTED}</p>
    </main>
  );
}
