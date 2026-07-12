import Link from 'next/link';
import { Zen_Maru_Gothic, Zen_Kaku_Gothic_New, Fraunces } from 'next/font/google';
import styles from './page.module.css';

// LP（マーケティング）。議事録で共有されたデザイン(osarai_lp_(4).html)を移植。
// ?ref=CODE で来た場合は紹介コードとしてsignupまで引き継ぐ（既存の?code=チャネル割引と同じパターン）。
// 全CTAに signupHref を使うこと(ハードコードの /signup を書かない)。

const zenMaru = Zen_Maru_Gothic({ subsets: ['latin'], weight: ['500', '700', '900'], variable: '--font-disp' });
const zenKaku = Zen_Kaku_Gothic_New({ subsets: ['latin'], weight: ['400', '500', '700'], variable: '--font-body' });
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  style: ['normal', 'italic'],
  variable: '--font-num',
});

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string; code?: string }>;
}) {
  const { ref, code } = await searchParams;
  const signupParams = new URLSearchParams();
  if (ref) signupParams.set('ref', ref);
  if (code) signupParams.set('code', code);
  const signupHref = signupParams.size > 0 ? `/signup?${signupParams.toString()}` : '/signup';

  return (
    <div className={`${styles.page} ${zenMaru.variable} ${zenKaku.variable} ${fraunces.variable}`}>
      <section className={styles.hero}>
        <div className={`${styles.wrap} ${styles.heroGrid}`}>
          <div>
            <span className={styles.eyebrow}>人と会ったあと、たった5分のおさらい習慣</span>
            <h1 className={styles.h1}>
              忙しくても、
              <br />
              <span className={styles.mark}>人を大切にできる<wbr />自分に。</span>
            </h1>
            <p className={styles.lead}>
              人と会ったあと、AIと5分話すだけ。
              <br />
              大切な人のことを、ちゃんと覚えておける。
            </p>
            <p className={styles.target}>
              保険・不動産・通信・物販から、美容・サロン・パーソナルジムまで──人と会って商売する、すべての人へ。
            </p>
            <div className={styles.heroCtaRow}>
              <Link href={signupHref} className={styles.cta}>
                14日間、無料でおさらい体験 <span className={styles.arrow}>→</span>
              </Link>
              <span className={styles.note}>初回14日間は課金なし（トライアル中の解約で0円）</span>
            </div>
          </div>

          <div className={styles.phoneStage}>
            <div className={styles.phone}>
              <div className={styles.phoneScreen}>
                <div className={styles.appTop}>
                  <div className={styles.appDot}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9 0-3 5-4 5-9M7 21c0-5 5-6 5-9 0 3 5 4 5 9"
                        stroke="#fff"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <div>
                    <div className={styles.appName}>
                      osar<b>AI</b>
                    </div>
                    <div className={styles.appSub}>おさらいモード</div>
                  </div>
                </div>
                <div className={styles.chat}>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>お疲れさま！さっきの田中さん、どうやった？</div>
                  <div className={`${styles.bubble} ${styles.bubbleMe}`}>ええ感じ。子どもの教育資金が不安って言うてた</div>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>いいですね。お子さんの年齢は聞けました？</div>
                  <div className={`${styles.bubble} ${styles.bubbleMe}`}>上が小1、下が年中</div>
                  <div className={`${styles.bubble} ${styles.bubbleDone}`}>
                    <span className={styles.check}>✓</span>田中さんのカード、整理しときました
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.sec} ${styles.problem}`}>
        <div className={styles.wrap}>
          <span className={styles.secTag}>The Problem</span>
          <h2 className={styles.h2}>覚えていたいのに、忙しくて、こぼれていく。</h2>
          <div className={styles.painList}>
            <div className={styles.pain}>
              <span>—</span>一度会って、それっきりになっている
            </div>
            <div className={styles.pain}>
              <span>—</span>次の連絡はいつも、記憶頼り
            </div>
            <div className={styles.pain}>
              <span>—</span>前回なにを話したか、もう思い出せない
            </div>
          </div>
          <p className={styles.secLead} style={{ color: 'var(--cream)', opacity: 0.8, marginBottom: 30 }}>
            紙やスマホにメモを取っても、探すのが大変で、結局そのまま埋もれていく。大切にしたい人なのに、余裕がなくて気にかけきれない──そんな自分が、ちょっと嫌になる。
          </p>
          <div className={styles.statBand}>
            <div className={styles.statBandBig}>51%</div>
            <p>
              出会った人の約半分とは、一度きりの縁で終わってしまう。
              <br />
              <span className={styles.src}>※リードの51%が一度も接触されないまま、というデータも（Demand Local）</span>
            </p>
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.wrap}>
          <span className={styles.secTag}>The Solution</span>
          <h2 className={styles.h2}>やることは、たった5分の「おさらい」だけ。</h2>
          <p className={styles.secLead}>
            人と会ったら、アプリを開いて、対話AIと5分話すだけ。フォームを埋める必要はありません。聞かれたことに、答えるだけ。
          </p>
          <div className={styles.steps}>
            <div className={styles.step}>
              <div className={styles.stepN}>01</div>
              <h3>話す</h3>
              <p>「どうやった？」とAIが聞いてくる。思い出して喋るだけ。</p>
            </div>
            <div className={styles.step}>
              <div className={styles.stepN}>02</div>
              <h3>整理される</h3>
              <p>相手・話した内容・ニーズを、AIが自動で顧客カードに整理。あなたは確認するだけ。</p>
            </div>
            <div className={styles.step}>
              <div className={styles.stepN}>03</div>
              <h3>聞く</h3>
              <p>次に何をすべきか、誰に連絡すべきか。AIチャットに聞けば、すぐ答えが返る。</p>
            </div>
          </div>
          <div className={styles.asks}>
            <div className={styles.ask}>新しい商品、喜んでくれそうなのは誰やろう？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>田中さんと佐藤さん、前に「こういうの欲しい」って話してましたよ。まず田中さんから連絡してみては？
            </div>
            <div className={styles.ask}>この人しばらく会ってないけど、どう連絡しよう？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>前回、お子さんの受験の話をされてましたね。「その後どうですか？」から入ると自然ですよ。
            </div>
            <div className={styles.ask}>&quot;こんな人つないで&quot;と言われたけど、誰かいたかな？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>鈴木さんが近いです。以前「紹介してほしい」とも仰ってたので、きっと喜ばれますよ。
            </div>
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.wrap}>
          <span className={styles.secTag}>Before &amp; After</span>
          <h2 className={styles.h2}>ひとりで抱え込むのを、やめる。</h2>
          <div className={styles.ba}>
            <div className={`${styles.baCard} ${styles.baBefore}`}>
              <h3>これまで</h3>
              <ul>
                <li>会った人を、だんだん忘れていく</li>
                <li>メモはどこかに埋もれて出てこない</li>
                <li>次の連絡は、いつも後手にまわる</li>
              </ul>
            </div>
            <div className={`${styles.baCard} ${styles.baAfter}`}>
              <h3>osarAIと</h3>
              <ul>
                <li>AIが、会った人を全部覚えている</li>
                <li>5分のおさらいで、整理は完了</li>
                <li>気にかけたい人に、ちゃんと連絡できる</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className={`${styles.sec} ${styles.obj}`}>
        <div className={styles.wrap}>
          <span className={styles.secTag}>Why It Lasts</span>
          <h2 className={styles.h2}>
            アプリの9割は、1ヶ月で使われなくなる。
            <br />
            osarAIが、続く理由。
          </h2>
          <div className={styles.objGrid}>
            <div className={styles.objCard}>
              <div className={styles.objQ}>どうせ続かへん？</div>
              <p className={styles.objA}>かかるのはたった5分。人と会ったあとに通知が来て、答えるだけ。&quot;思い出してやる作業&quot;にならないから続く。</p>
            </div>
            <div className={styles.objCard}>
              <div className={styles.objQ}>入力が面倒では？</div>
              <p className={styles.objA}>入力しません。AIが聞いてくるので、答えるだけ。フォームとにらめっこする時間はゼロ。</p>
            </div>
            <div className={styles.objCard}>
              <div className={styles.objQ}>難しそう…</div>
              <p className={styles.objA}>喋るだけ。雑に話しても、AIがきれいに整えます。</p>
            </div>
          </div>
        </div>
      </section>

      <section className={styles.sec}>
        <div className={styles.wrap}>
          <span className={styles.secTag}>The Evidence</span>
          <h2 className={styles.h2}>人を大切にした分だけ、結果はついてくる。</h2>
          <div className={styles.nums}>
            <div className={styles.numbox}>
              <div className={styles.numboxV}>×3</div>
              <div className={styles.numboxL}>リード転換率が最大3倍に</div>
              <div className={styles.numboxS}>出典：Forrester</div>
            </div>
            <div className={styles.numbox}>
              <div className={styles.numboxV}>+29%</div>
              <div className={styles.numboxL}>顧客管理の導入で売上が平均増加</div>
              <div className={styles.numboxS}>出典：Salesforce</div>
            </div>
            <div className={styles.numbox}>
              <div className={styles.numboxV}>9割</div>
              <div className={styles.numboxL}>
                一般的なアプリは1ヶ月で離脱
                <br />
                <b style={{ color: 'var(--orange-deep)' }}>osarAIは&quot;続く&quot;側へ。</b>
              </div>
              <div className={styles.numboxS}>出典：Business of Apps</div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className={styles.final}>
          <h2 className={styles.h2}>
            忙しくても、
            <br />
            人を大切にできる自分に。
          </h2>
          <p>たった5分の習慣から、新しい働き方を。</p>
          <Link href={signupHref} className={`${styles.cta} ${styles.ctaLarge}`}>
            14日間、無料でおさらいを体験する <span className={styles.arrow}>→</span>
          </Link>
          <p className={styles.finalNote}>初回14日間は無料（トライアル中の解約で課金なし）</p>
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.wrap}>
          <div className={styles.logo}>
            osar<b>AI</b> <small>おさらい</small>
          </div>
          <div>忙しくても、人を大切にできる自分に。</div>
        </div>
      </footer>
    </div>
  );
}
