import Link from 'next/link';
import { Zen_Maru_Gothic, Zen_Kaku_Gothic_New, Fraunces } from 'next/font/google';
import styles from './page.module.css';

// LP（マーケティング）。議事録で共有されたデザイン(osarai_lp_(4).html)を移植。
// 2026-09-27: 訴求を「AIと5分話すおさらい」から「会議を録音するだけで、議事録・予定・TODOが残る」に
// 書き換えた（デザイン・構成はそのまま・人判断）。
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
            <span className={styles.eyebrow}>Zoomも対面も、録音ボタン1つで</span>
            <h1 className={styles.h1}>
              忙しくても、
              <br />
              <span className={styles.mark}>人を大切にできる<wbr />自分に。</span>
            </h1>
            <p className={styles.lead}>
              会う前に、ボタンを押すだけ。
              <br />
              議事録も、次の予定も、やることも、AIが全部残します。
            </p>
            <p className={styles.target}>
              保険・不動産・通信・物販から、美容・サロン・パーソナルジムまで──人と会って商売する、すべての人へ。
            </p>
            <div className={styles.heroCtaRow}>
              <Link href={signupHref} className={styles.cta}>
                14日間、無料で試してみる <span className={styles.arrow}>→</span>
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
                    <div className={styles.appSub}>会議の記録</div>
                  </div>
                </div>
                <div className={styles.chat}>
                  <div className={`${styles.bubble} ${styles.bubbleDone}`}>
                    <span className={styles.check}>✓</span>田中さんとの会議を保存しました
                  </div>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>議事録：お子さん2人の教育資金が不安。上が小1、下が年中</div>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>予定：10/8(水) 14:00 カフェで2回目</div>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>TODO：学資の比較資料を送る（10/7まで）</div>
                  <div className={`${styles.bubble} ${styles.bubbleAi}`}>相手待ち：ご主人の意向を確認して連絡</div>
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
              <span>—</span>メモを取りながらだと、相手の話に集中できない
            </div>
            <div className={styles.pain}>
              <span>—</span>終わったあと、予定とやることを手で入れ直している
            </div>
            <div className={styles.pain}>
              <span>—</span>前回なにを話したか、もう思い出せない
            </div>
          </div>
          <p className={styles.secLead} style={{ color: 'var(--cream)', opacity: 0.8, marginBottom: 30 }}>
            紙やスマホにメモを取っても、探すのが大変で、結局そのまま埋もれていく。約束した資料も、次の連絡も、気づけば後回し。大切にしたい人なのに、余裕がなくて気にかけきれない──そんな自分が、ちょっと嫌になる。
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
          <h2 className={styles.h2}>やることは、会う前にボタンを押すだけ。</h2>
          <p className={styles.secLead}>
            Zoomの前でも、対面で会う前でも、録音ボタンを押すだけ。メモも入力もいりません。終わったら、あとはAIにおまかせ。
          </p>
          <div className={styles.steps}>
            <div className={styles.step}>
              <div className={styles.stepN}>01</div>
              <h3>録る</h3>
              <p>会う前に録音ボタンを押すだけ。会議にボットは入らないので、相手に気を遣わせません。録音するときは、相手に一言伝えておくのがおすすめです。</p>
            </div>
            <div className={styles.step}>
              <div className={styles.stepN}>02</div>
              <h3>残る</h3>
              <p>議事録・次の予定・自分のやること・相手の約束を、AIが自動で保存。確認も入力もいりません。</p>
            </div>
            <div className={styles.step}>
              <div className={styles.stepN}>03</div>
              <h3>思い出す</h3>
              <p>次に会う前に、前回の話をすぐ読み返せる。AIに聞けば、これまでの会議を踏まえて答えます。</p>
            </div>
          </div>
          <div className={styles.asks}>
            <div className={styles.ask}>明日、田中さんと2回目。何から話せばいい？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>前回、お子さんの教育資金が不安と話されてました。送った比較資料の感想から入ると自然ですよ。
            </div>
            <div className={styles.ask}>返事が来てない件って、どれやったっけ？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>佐藤さんの「見積もりの確認」が、期限を2日過ぎています。軽く声をかけてみては？
            </div>
            <div className={styles.ask}>&quot;こんな人つないで&quot;と言われたけど、誰かいたかな？</div>
            <div className={styles.askAi}>
              <span className={styles.who}>osarAI</span>鈴木さんが近いです。前回の会議で「紹介してほしい」と話されていたので、きっと喜ばれますよ。
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
                <li>メモを取りながら、相手の話を聞いている</li>
                <li>予定もやることも、あとで手で入れている</li>
                <li>前回の話を思い出せないまま会っている</li>
              </ul>
            </div>
            <div className={`${styles.baCard} ${styles.baAfter}`}>
              <h3>osarAIと</h3>
              <ul>
                <li>相手の話に、まっすぐ集中できる</li>
                <li>予定もTODOも、気づけば入っている</li>
                <li>会う前に、前回の話を30秒で読み返せる</li>
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
              <p className={styles.objA}>やることは録音ボタンを押すだけ。終わったあとは何もしなくても保存されるから、&quot;がんばって続ける作業&quot;がありません。</p>
            </div>
            <div className={styles.objCard}>
              <div className={styles.objQ}>入力が面倒では？</div>
              <p className={styles.objA}>入力しません。議事録も予定もTODOも、AIが会話から拾って入れておきます。間違いだけ、あとから直せば大丈夫。</p>
            </div>
            <div className={styles.objCard}>
              <div className={styles.objQ}>難しそう…</div>
              <p className={styles.objA}>押すのはボタン1つ。オンラインの会議はパソコン、対面はスマホで録れます。</p>
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
          <p>ボタン1つから、新しい働き方を。</p>
          <Link href={signupHref} className={`${styles.cta} ${styles.ctaLarge}`}>
            14日間、無料で試してみる <span className={styles.arrow}>→</span>
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
