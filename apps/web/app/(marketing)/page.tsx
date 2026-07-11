import Link from 'next/link';

// LP（マーケティング）。既存 osarai_lp.html のデザイン踏襲はWebフェーズで。— フェーズ1は骨組み。
// ?ref=CODE で来た場合は紹介コードとしてsignupまで引き継ぐ（既存の?code=チャネル割引と同じパターン）。
export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;
  const signupHref = ref ? `/signup?ref=${encodeURIComponent(ref)}` : '/signup';
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px' }}>
      <h1>osarAI 〜おさらい〜</h1>
      <p style={{ fontSize: 18 }}>忙しくても、人を大切にできる自分に。</p>
      <p>人と会ったあと5分の、AI対話"おさらい"習慣。</p>
      <p style={{ marginTop: 32 }}>
        <Link href={signupHref}>14日間無料で試す →</Link>
      </p>
    </main>
  );
}
