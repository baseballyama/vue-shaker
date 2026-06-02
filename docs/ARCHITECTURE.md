# vue-shaker アーキテクチャ設計

> Vue 3 の SFC（`.vue`）を「コンパイル前のソース段階」で部分評価し、未使用 props に紐づく
> dead code をツリーシェイクしてから Vue コンパイラへ渡す Vite / Rollup プラグイン。
> いわば **「Vue 版 Rollup tree-shaking」**。`svelte-shaker` の Vue 3 移植版。

最終的には性能のため中核エンジンを Rust（[vize](https://github.com/baseballyama/vize) = arena 上の
Vue コンパイラ／ツールチェーン）で実装する。本書はまず TypeScript で動かしつつ、最初から Rust へ
無理なく差し替えられる層構造を定義する。

> **スコープ（決定済み）**：**`<script setup>` + `defineProps` / `withDefaults` 専用**
> （Reactive Props Destructure〔Vue 3.5+〕または `withDefaults(defineProps(), {...})`）。
> Options API / 素の `<script>` は対象外＝静かに素通し。
> **未使用・定数畳み済み prop は署名から落とす（攻め）**を既定とする。詳細は §12。

---

## 1. なぜこれが必要で、なぜコンパイル後では不可能なのか

### 1.1 解きたい問題

デザインシステム／UI ライブラリのコンポーネントは props が非常に多い（`Button` に
`variant / size / loading / icon / iconPosition / fullWidth / rounded / as / href ...`）。
しかし個々のアプリは、その一部しか使わない。使われない props に紐づくコード
（テンプレート分岐・クラス計算・computed・import・CSS）は、そのアプリにとって
**実質的に dead code** だが、現状のツールチェーンでは消えずにバンドルへ残る。

```vue
<!-- Button.vue（ライブラリ側、30 props） -->
<script setup lang="ts">
  const { variant = 'primary', loading = false, icon } = defineProps<{
    variant?: string; loading?: boolean; icon?: string; /* …28 more… */
  }>();
</script>
<template>
  <Spinner v-if="loading" />
  <Icon v-if="icon" :name="icon" />
  <button :class="`btn btn-${variant}`"><slot /></button>
</template>

<!-- アプリ側：loading も icon も一度も渡さない -->
<Button variant="primary">Save</Button>
```

このアプリでは `loading` / `icon` のコードは到達不能。`<Spinner>` も `<Icon>` も実際には
不要なので、それらのモジュール・CSS ごと消えてほしい。

### 1.2 なぜ Vue コンパイル後の JS では消せないのか

Vue コンパイラは **1 SFC = 1 JS モジュール**（`render` 関数 + `setup`）を、全呼び出し元で
共有できるよう汎用的に出力する。生成 JS では prop の値はランタイム（`__props` / `props.variant` /
リアクティブ getter）を経由する間接値になり、`variant` や `loading` は
**JS 上の静的定数として現れない**。

その結果：

- terser / esbuild / Rollup の DCE は `loading ? ... : ...` や `_createBlock(loading ? Spinner : ...)`
  を `false` 側に畳めない（`loading` がランタイム由来で定数と証明できない）。
- 1 モジュールは「将来どんな呼び出しでも動く」前提なので、特定アプリでの未使用 prop を
  消すのは **ホールプログラム情報を持たないコンパイラには原理的に不可能**。

→ **解決策：prop の値（`defineProps`/`withDefaults` の default やコールサイトのリテラル）が
まだソース上に見えていて、テンプレート構造も無傷な「コンパイル前 Vue SFC AST」の段階で部分評価し、
dead code を削ってからコンパイラへ渡す。** これが vue-shaker の核心。

---

## 2. 中核アイデア：ホールプログラム部分評価器

vue-shaker は本質的に **Vue を理解する partial evaluator（部分評価器）兼 DCE** であり、
それを **アプリ全体のコールサイト情報** で駆動する。

```
全コールサイトを走査
        │  各 <Comp :prop="..."/> から「prop → 値の抽象」を集約
        ▼
コンポーネントごとの PropProfile（この prop は一度も渡されない / 常に同じ定数 / 動的…）
        │  既知の定数を default ともども prop へ代入
        ▼
定数畳み込み（script + template + CSS class）
        ▼
DCE（死んだ分岐・computed・宣言・import・未使用 CSS を除去）
        ▼
スリム化した Vue SFC ソースを再生成 → 公式 Vue コンパイラへ
```

ポイントは「prop を消す」とは結局 **「prop をその確定値で置換し、定数畳み込みして DCE する」**
だということ。一度も渡されない prop はその値が常に default なので、
`const { x = false } = defineProps<...>()` は `const x = false` と等価になり、
下流の畳み込みが分岐を消す。

### 2.1 グラフ上の不動点（fixpoint）= カスケード削減

これは 1 コンポーネント内で閉じない。prop 削減が **子コンポーネントの呼び出しごと消す** と、
子の PropProfile が変わり、さらに削れる：

```
App が Button に icon を渡さない
  → Button 内 <Icon v-if="icon"/> が false 畳み → <Icon> の呼び出しが消える
    → アプリ内で Icon の呼び出しが他になければ Icon モジュールごと dead（Rollup が落とす）
    → Icon が他で限定的にしか使われないなら Icon の PropProfile も縮む → さらに削減
```

よって **解析はコンポーネントグラフ上の不動点反復**になる（削れなくなるまで回す）。

### 2.2 値の抽象とジョイン束（lattice）

prop `p`（コンポーネント `C`）の、全コールサイトにわたる抽象値は以下の束のジョインで求める。
**「あるサイトで `p` を渡さない」= そのサイトでは `p` は default 値**として束に参加させる
（これが「未使用 = default で畳める」を自然に表現する鍵）。

```
                 ⊤  Unknown / Dynamic
                /   |   \         （v-bind不明・動的式・v-model・escape のいずれか）
          Const(a) Const(b) …    （リテラル。値が割れたら multi=値集合として L1.5 で活用）
                \   |   /
              SingleConst（全サイトで唯一の定数）
                    │
                    ⊥  まだ呼び出しなし
```

- `⊥ ⊔ x = x`
- `Const(a) ⊔ Const(a) = Const(a)`
- `Const(a) ⊔ Const(b) (a≠b)` … `multi={a, b}`（値集合）として保持。**L1.5 で到達可能値集合**として
  使い、集合外の分岐・CSS を消す。L2 ではさらに形状別モノモーフィズに使う。
- 動的式 / 解決不能 `v-bind="rest"` / `v-model` / コンポーネントの escape は即 `⊤`。

`⊤` になった prop は削れない（=使われ得る）。`Const(v)`（default 込みで単一定数）に
収束した prop は `v` で畳める。一度も渡されない prop は「全サイトで default」= `Const(default)`。

> **フィクスチャ `basic1` の位置づけ**：`<Sub :has-icon="false"/>` が唯一の呼び出し →
> `hasIcon` は `Const(false)` に収束 → `<p v-if="hasIcon">` を `v-if="false"` に畳んで
> `<p>Icon</p>` を除去。これは後述の **L1** に相当する。
>
> **採用方針（決定済み）**：prop 署名まで縮める（攻め）。よって `Sub` 側は `hasIcon` を
> `defineProps` から落とし、連動して `App` 側の `:has-icon="false"` 属性も除去する。
> フィクスチャ `basic1/expected`（宣言を残す保守版も可）は、この既定に合わせて
> 整備する（§12-2 / §7 参照）。

---

## 3. 最適化レベル（段階導入）

攻めるほど削れるがリスク／複雑度／コードサイズが増す。レベルで段階導入する。

| Lv       | 名前                         | 何をするか                                                                                                          | モジュール数                  | 既定   |
| -------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------ |
| **L0**   | 未使用 prop 除去             | どのサイトからも渡されない prop を default で畳んで DCE。**`defineProps` の署名からも落とす**                       | 1/コンポーネント              | ✅     |
| **L1**   | 全アプリ定数伝播             | 全サイトで同一リテラルに収束する prop を畳む（`basic1` がこれ）。署名から落とし、**全コールサイトの該当属性も除去** | 1/コンポーネント              | ✅     |
| **L1.5** | **値集合ナローイング**       | 全サイトの到達可能値集合（例 `variant ∈ {primary, secondary}`）で、集合に無い値の分岐・CSS を除去                   | 1/コンポーネント              | ✅     |
| **L2**   | コールサイト・モノモーフィズ | prop 形状ごとにコンポーネントを複製・特殊化                                                                         | N/形状（dedup・サイズガード） | opt-in |

- **L0/L1/L1.5 が本命**。1 コンポーネント 1 モジュールを保つので安全・低コスト・コードサイズ増なし。

#### L1.5 値集合ナローイング（「使わない variant を消す」主力）

`variant` のような prop は L1 では `Const('primary') ⊔ Const('secondary') = Dynamic` となり
「使われている」と諦めてしまう。だが実際には **到達可能な値集合 `{primary, secondary}`** が分かれば、
集合に無い値に紐づくコードは dead。よって束に **`multi`（値集合）抽象**（§2.2）を保持し、次を消す：

- 明示分岐：`<x v-if="variant === 'danger'">` / `v-else-if` / `switch(variant)` の `danger`/`ghost`/`link` ケース
- オブジェクトマップ：`styles[variant]` の到達不能キー（他で参照されない場合）
- **CSS（shaker 独自の価値・Vue では Svelte 以上に重要）**：`:class="`btn btn-${variant}`"` のような
  文字列補間は対応するクラスが静的に追えない。**しかも Vue は Svelte と違い「未使用 CSS セレクタの刈り取り」を
  そもそも行わない**（`<style scoped>` は `data-v-*` 属性スコープを付けるだけで、テンプレートで使われていない
  ルールも残す）。したがって `.btn-danger` のような到達不能ルールの除去は **完全に vue-shaker の責務**。
  shaker は「variant ∈ {primary,secondary} だから `btn-danger` は生成不能」と判定して **CSS ルールごと除去**できる。
  これは Svelte 版以上に強い差別化要因（§6.1 参照）。

健全性の鍵：値集合ナローイングは **「全コールサイトを把握済み」が前提**。1 箇所でも `v-bind`/escape/
動的式で `⊤` になると集合は「全値」に退化し、ナローイングが死ぬ。よって **§4.1 の部分 bail
（`⊤` を prop 単位に局所化して減らす）が L1.5/L2 の効きを直接左右する前提条件**になる。
初期はコールサイトがリテラルのケースのみ対象（`:variant="v"` は将来 TS の union literal 型から
集合を絞る高度化余地）。

#### L2 真のモノモーフィズ（opt-in、**測定ベースの純減ゲートで「絶対に肥大させない」**）

L1.5 で削った後、`<Button variant="primary">` の**呼び出しごと**に `variant='primary'` 固定の複製を作り
`variant==='primary'` を true 畳みして primary 以外を全消し…という素朴な L2 は**最強だが形状数だけ複製が
増え、しばしばバンドルを肥大させる**。ここが核心の洞察：

> **なぜ素朴な L2 は肥大するのか / L2 が本当に効くのはどこか**
>
> **L1.5 は既に「アプリ全体で到達不能なアーム」を消している**。だから L2 が**バンドルを縮める**のは、
> 特殊化によって**あるモジュール全体がプログラム全体から参照されなくなる**ときだけ。これは **L1.5 の
> 独立ナローイングでは殺せない「相関した複数 prop 条件」**で起こる。代表例：
>
> ```vue
> <!-- Child.vue -->
> <template>
>   <Heavy v-if="a === 1 && b === 1" /><p>base</p>
> </template>
> ```
>
> アプリ全体で `a ∈ {0,1}`・`b ∈ {0,1}` だが、コールサイトは `<Child :a="0" :b="1"/>` と
> `<Child :a="1" :b="0"/>` だけ＝**`(1,1)` は決して起きない**。L1.5 は `a`・`b` を**独立に**narrowing する
> ので `a && b` が両方 1 にならないことを証明できず、`<Heavy/>` を残す → Heavy はバンドルに残る。
> L2 は各サイトを特殊化（`a` か `b` が定数化）→ **どちらの variant でも `v-if="a===1&&b===1"` が false に
> 畳まれ** → `<Heavy/>` が全 variant から消える → **Heavy がプログラム全体から未参照** → バンドラが
> Heavy を丸ごと落とす。**これが L2 の唯一の勝ち筋**。
>
> 逆に、**モジュール消去を伴わない素の `variant ∈ {a,b}`（インラインアームのみ）は特殊化してはならない**：
> 形状ごとのモジュールに割ると共有スキャフォールドが複製されてバンドルが**増える**だけ。

そこで L2 は **graph-aware・測定ベースの純減（net-win）ゲート**で、**消した方がプログラム全体のモジュール
集合が縮むときだけ**子を特殊化する：

1. **ALL-SITES-OR-NOTHING（子 C 単位）**：C を特殊化するのは、プログラム全体の **生きている全コールサイト**
   （dead `v-if` span 内・共有述語で除外）が**残らず非ベース residual（本物の variant）になる**ときだけ。
   1 つでもベースを保つ生サイトがあれば C は特殊化しない（さもないと **ベースが残ったまま variant が増える＝
   純粋な肥大**）。全サイト特殊化なら C のベースモジュールが未参照になり、バンドラが落とせる。
2. **whole-program live render グラフ**：ノード＝コンポーネントモジュール、辺 `O → X` ＝ O の residual 内の
   各生 `<X/>`（通常コンポーネントはベース residual、candidate の variant は variant ソースをパースして C の
   import マップで `<X/>` を解決）。到達ルート＝**shake entries**（Shell が全 `.vue` を渡すため、
   他コンポーネントから render される entry は落とし、真の import グラフ根のみをルートにする）。
3. **`ownSize(residual)`**：`@vue/compiler-sfc` で client JS にコンパイルした `code.length`
   （per-module の byte 代理。共有 npm/.ts 依存は両シナリオで同一なので無視可）。
   メモ化。コンパイルエラーは「サイズ不能」として当該子を非特殊化（skip）。
4. **2 シナリオ測定**：candidate 子 C（dedup 済み variant 集合 `{V1..Vk}`, `k ≤ maxVariants`）について、
   - `Σ_base` ＝ entries から**ベースシナリオ**で到達するコンポーネント集合の `ownSize(ベース residual)` 合計。
   - `Σ_spec` ＝ 同じ到達性だが C を variant に置換：C のサイトは Vi を render、C.base は除去、各 Vi は自分の
     生子を render。variant は `ownSize(Vi)`、それ以外はベースサイズ。
   - **`Σ_spec < Σ_base * (1 - minSavings)` のときだけ C を特殊化**（厳密純減）。それ以外はベース維持。
     candidate 同士は**互いに独立**に同一ベースへ評価する（相互作用は後続。常にベース比較＋厳密純減なので
     union が肥大することはない＝健全）。判断に迷えば**特殊化しない**。

これにより **L2 ON のバンドルは常に L1.5（既定）バンドル以下**（byte）になることが構成的に保証される。
import は `virtual:shaker/Button?shaker_variant=<n>` 相当の仮想モジュールへ張り替え、同形状は dedup する。**opt-in**。

> **実装状況（L2 net-win ゲート / 計画中）**：エンジン（`src/mono.ts`）が **コールサイトごとの特殊化
> residual・dedup マップ・測定ベースの純減ゲート**を計算する設計。`shaker({ level: 2, monomorphize: true })`
> （Vite/Rollup）または `vueShakerWithMono(entries, …, { enabled: true, maxVariants, minSavings })` で
> **opt-in** とする。既定は OFF で**完全に byte 一致**（挙動不変）。L2 は L0/L1/L1.5 を緑にした後の段階。
>
> - **健全性（構成的）**：特殊化するのは (1) **生きている**コールサイト（dead `v-if` span 内は除外、
>   fixpoint と同一述語）かつ (2) その prop が **`v-bind="rest"` に上書きされ得ないリテラル**であるサイトのみ
>   （`afterLastSpread` かつ非 `dynamic`、§4.1 の部分 bail と同条件）。bail 済みコンポーネント
>   （escape/barrel/`expose`）・shadow される prop（scoped slot / `v-for` スコープ変数）・L1 で既に畳んだ prop は
>   特殊化しない。residual は **L0/L1/L1.5 と同一の監査済みボディパイプライン**（`shakeBody`）で
>   生成し、L2 は fold 環境を増やすだけ。
> - **絶対に肥大しない（net-win ゲート）**：上記 1–4 の all-sites-or-nothing ＋ 測定ベース `Σ_spec < Σ_base`
>   判定。`Σ_spec` の到達性は「C の全入辺を全 variant に展開」する**健全な上界**なので、迷えば**特殊化を見送る**
>   側に倒れる（真の勝ちを逃すことはあっても、決して肥大しない）。`minSavings`（既定 0＝厳密純減のみ）を
>   `MonomorphizeOptions` に追加。上げると保守側に倒れるだけで unsound にはならない（§13.2 精度ノブ）。
> - **dedup（residual 等価）**：dedup キーは **residual ソースそのもの**。byte 一致する residual は 1
>   モジュールを共有する（§13.2「相異なる residual 数で内在的に有界」）。瓜二つコピーは構成的に生じない。
> - **CSS も連動**：frozen prop は定数化するので、その variant 内では到達不能クラスの CSS ルールがさらに
>   消える（`variant="primary"` の複製から `.btn-danger` が落ちる。CSS 除去は Vue では shaker 自前なので一貫処理）。
> - **`maxVariants` cap**：相異なる residual 数の上限（コンポーネント単位、既定 8）。超過した子は**全サイトを
>   特殊化できない**＝ベースが残るので、その子は丸ごとベース維持（部分分割はしない＝常に健全）。
> - **配線（Vite/Rollup Shell）**：variant は **元の子ファイルパス + `?shaker_variant=<n>` クエリ**の仮想
>   リクエストとして公開する（相対 import が無特殊化の子と同一に解決される）。Shell の `resolveId`/`load`
>   が residual を供給し、所有側ソースの該当 `<Child …>` を variant import へ張り替え、frozen 属性のみ除去
>   （`v-bind="rest"` 等は保持）。差分 SSR で「発生する値について観測等価」をテストで保証する。

---

## 4. 健全性（soundness）と bail-out フレームワーク

最適化器が「たまに壊す」と無価値（サイレントにアプリが壊れる）。
**正しさ > 攻め**を絶対原則とし、危険な機能（poison features）に対しては最適化を見送る「bail-out」を持つ。

### 4.1 部分 bail フレームワーク（既定）

**完全 bail**（危険機能が 1 つでもあればコンポーネントの全 prop を諦め素通し）は安全だが、
実アプリは `v-bind="..."`（spread）/ rest を多用するためほとんど効かなくなる。よって既定は **部分 bail**：
**危険機能の影響を prop 単位に局所化し、影響を受けない prop の最適化は続ける**。
（部分 bail で `⊤` を減らすことは §3 L1.5/L2 の値集合ナローイングが効くための前提でもある。）

| poison feature                                                                                          | 影響範囲                     | 部分 bail の扱い                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **コールサイトの spread** `<Comp v-bind="rest" :a="1" :b="2" />`                                        | rest が埋めうる prop         | **後勝ち順序で救う**：`v-bind="rest"` より**後ろ**に明示された prop は確定 → 救う。spread より前/同名は `⊤`。`rest` が解決可能な object literal なら key 展開して narrowing |
| **コンポーネント側が rest を読む** `const { variant, ...rest } = defineProps<...>()`                    | rest に流れる「未宣言 prop」 | **明示宣言 prop（`variant`）は救う**。rest 経由（`v-bind="rest"` で DOM 転送）の未宣言 prop は削除不可                                                                    |
| **`v-model` / `v-model:prop`（双方向）**                                                                | その prop のみ               | その prop だけ「使用 & 動的」で `⊤`。他 prop は通常通り                                                                                                                  |
| **`defineExpose` / `defineOptions({ inheritAttrs })` で公開 / customElement（`defineCustomElement`）** | コンポーネント全体           | props が公開 API・要素属性になり外部設定され得る → **完全 bail**                                                                                                         |
| **escape**（`<component :is="X"/>` / コンポーネントを値として代入・関数渡し・配列格納・`<KeepAlive>` 経由の動的解決） | コンポーネント全体           | 漏れた先の使われ方を追うのはポイント解析が必要で割に合わない → **完全 bail**（簡易 escape 解析で検知）                                                                   |

- **副作用の保存**（横断原則）：値が未使用でも観測可能な副作用（`watch` / `watchEffect` / `onMounted` 等の
  ライフサイクル副作用・純粋性不明な関数呼び出し）を持つコードは削らない。純粋かつ未使用と証明できた場合のみ除去。
- 補足：`<script setup>` + `defineProps`/`withDefaults` 専用方針（§12-1）のため、Options API の
  `props: {...}` や `this.$props` / `$attrs` 経由のアクセスは対象外（素通し）。`<script setup>` の rest は
  上表「コンポーネント側が rest を読む」で扱う。

### 4.2 ライブラリ境界 — どのビルドで動かすか

未使用 prop の判定は **「このアプリの全消費者」を知って初めて成り立つ**。よって：

- vue-shaker は **アプリ側のビルド**で動かす。`node_modules` のデザインシステムも
  「このアプリ用の入力」として特殊化する。
- ただし **ライブラリが `.vue` ソースで配布されている**ことが前提。コンパイル済み JS
  （`render` 関数化済み）を配布するライブラリは shaker の対象外（§1.2 の理由でソースが要る）。
  → ドキュメントで「shake 可能な配布形態」を明示し、対象外は静かに素通しする。

---

## 5. 層構造（Shell / Engine / IR）

Rust 差し替えを最初から可能にするため、**環境グルー（Shell）** と
**Vue の賢さ（Engine）** を厳密に分離し、間を **安定した IR / データ契約**でつなぐ。

```
┌─────────────────────────────────────────────────────────────┐
│  Shell  =  Vite / Rollup プラグイン（常に JS/TS）             │
│  ・フック（buildStart / resolveId / transform）              │
│  ・モジュール解決（this.resolve — Vite エコシステム互換のため JS 必須）│
│  ・ファイル IO / キャッシュ / HMR ポリシー / 診断の表示      │
└───────────────▲───────────────────────────┬─────────────────┘
        EngineResponse                 EngineRequest（= IR）
┌───────────────┴───────────────────────────▼─────────────────┐
│  Engine  =  解析 + 変換のコア（TS 実装 → Rust 実装に差替）   │
│  ・parse（SFC descriptor + template AST + script setup bindings）│
│  ・whole-program 解析（PropProfile・fixpoint）               │
│  ・部分評価（substitute → fold → DCE）                       │
│  ・Vue SFC ソース再生成（+ sourcemap）                       │
└─────────────────────────────────────────────────────────────┘
```

**Shell が握るもの**：Vite/Rollup のフック、`this.resolve` によるモジュール解決
（プラグインエコシステム互換のため JS に残す）、ファイル読み込み、キャッシュ、
dev/HMR の方針、診断のターミナル表示。

**Engine が握るもの**：Vue 固有の全処理。env 非依存・純粋関数的にし、入出力を IR で固定する。

### 5.1 エンジン境界の IR（データ契約）

```ts
// コンポーネント識別子：解決済み絶対パス（+ 必要なら export 名）
type ComponentId = string;

// 1 prop の、全サイトにわたる抽象値（§2.2 の束）
type PropAbstraction =
  | { kind: 'bottom' } // まだ呼び出しなし
  | { kind: 'const'; value: JsonLiteral } // 単一定数に収束
  | { kind: 'multi'; values: JsonLiteral[] } // 到達可能値集合（L1.5 ナローイング / L2）
  | { kind: 'dynamic' } // 使われている・値不定
  | { kind: 'top'; reason: BailReason }; // 削除不可（escape / rest / v-bind …）

// 解析が各コンポーネントに対して出す「計画」
interface ComponentPlan {
  id: ComponentId;
  bail: boolean; // 完全 bail なら素通し（defineExpose/customElement/escape）
  reasons: BailReason[];
  bailedProps: Set<string>; // 部分 bail：この prop だけ ⊤（spread後勝ち/rest/v-model）
  removable: Map<string, JsonLiteral>; // L0：default で畳む prop
  constFold: Map<string, JsonLiteral>; // L1：確定定数で畳む prop
  narrow: Map<string, JsonLiteral[]>; // L1.5：到達可能値集合（集合外の分岐/CSSを除去）
  // L2 用の形状割当ては別途 VariantPlan として持つ
}

// Engine への 2 つの入力フェーズ
interface AnalyzeInput {
  // フェーズ1：解析
  files: Array<{ id: ComponentId; code: string; lang: 'js' | 'ts' }>;
  edges: Array<{ from: ComponentId; to: ComponentId; props: CallSiteProps }>;
  options: ShakerOptions;
}
interface TransformInput {
  // フェーズ2：変換
  file: { id: ComponentId; code: string; lang: 'js' | 'ts' };
  plan: ComponentPlan;
}
interface TransformResult {
  code: string; // スリム化した .vue ソース
  map: SourceMap; // shaken → original（デバッグ用）
  emptiedImports: ComponentId[]; // 次の fixpoint ラウンドへのヒント
  diagnostics: Diagnostic[];
}
```

この IR が JSON シリアライズ可能であることが Rust 化（napi raw-transfer / WASM）を素直にする。

---

## 6. Vite / Rollup 統合（Shell の具体設計）

### 6.1 2 パス構成

ホールプログラム解析は「全コールサイトを見てから特殊化」する必要があるが、Vite/Rollup は
モジュールを遅延・個別に処理する（鶏と卵）。そこで **解析を自前クロールで前倒し**する。

```
buildStart:
  entry（Rollup input / Vite config）から import グラフを自前で辿り、
  .vue / .[jt]s を「コンパイルせず」軽量パースして
    ・各コンポーネントの defineProps/withDefaults 宣言 + default
    ・各 <Comp .../> のコールサイト prop 形状（:bind / 静的属性 / v-bind / v-model）
    ・コンポーネント識別子の escape（<component :is>）
  を収集 → Engine.analyze() → PropProfile → fixpoint → Map<ComponentId, ComponentPlan>

transform（enforce: 'pre'：@vitejs/plugin-vue より前）:
  対象 .vue ごとに ComponentPlan を引き、Engine.transform() を適用
  → スリム化した .vue ソース + sourcemap を返す
  → そのまま公式 Vue プラグインがコンパイル
```

- 自前クロールでファイルを 2 度パースする（クロール時 + コンパイル時）。クロール用パースは
  「import / コールサイト prop 形状 / prop 宣言」だけ取れれば良く軽い。AST をキャッシュして
  transform 時に再利用する。**ここがまさに Rust（高速パース）の効くホットパス**。
- **順序**：`enforce: 'pre'` で `@vitejs/plugin-vue` の transform より前に走らせ、
  `.vue → スリム化した .vue` を返す。我々は「コードを消すプリプロセッサ」に徹し、
  Vue の codegen には一切踏み込まない（バージョン非依存・疎結合）。
- **CSS シェイク（Vue では shaker が全責任を負う）**：**Svelte と決定的に異なる点**。Svelte は
  死んだマークアップを消せば対応 CSS をコンパイラの「未使用セレクタ除去」が後段で刈ってくれたが、
  **Vue コンパイラは未使用 CSS ルールを刈らない**（`<style scoped>` は `data-v-*` スコープ属性を
  付けるだけ）。したがって vue-shaker は **到達不能 CSS ルールの除去をすべて自前で所有する**
  （`css.ts`：死んだマークアップに紐づくセレクタ・L1.5 で集合外と判明したクラスルールを除去）。
  これにより CSS の差別化は Svelte 版より**さらに強い**（Vue 単体では一切届かない領域だから）。

### 6.2 dev / HMR ポリシー — dev では原理的にやらない（既定 off）

**dev で shake しないのは妥協ではなく正しい設計**。これは本最適化の本質に由来する：

- **ホールプログラム前提と HMR の局所性が根本的に相容れない**。本最適化は全コールサイト集約＋
  グラフ不動点に依存する。dev/HMR は「変更モジュールだけ局所再処理」が信条で、1 コールサイトの
  編集が子・孫の PropProfile を変え広範囲を無効化する。
- **L1.5/L2 は「その値は存在しない」という負の情報に依存する**。dev はモジュールを遅延ロードするため
  「まだ読まれていないファイルに新しい variant 使用があるかも」を排除できず、楽観的に消すと後から壊れる。
  毎回ルートから完全クロールすれば防げるが、それは dev の速さを殺す。
- **Vite dev がそもそも tree-shaking しない**のと同じ理由（dev は unbundled ESM、shake は本番ビルド限定）。
  これに倣うのが一貫していて自然。

したがって既定：

- **`vite build`（本番）でのみ shake**。`serve`/dev は**素通し**（未最適化だが常に正しく、HMR が単純）。
- 唯一の懸念 **dev/prod 乖離** は、shaker が**健全な最適化（観測挙動を変えない）**である保証で守る。
  乖離が出たらそれは shaker のバグ → **CI で「shake あり/なしの prod ビルドが同じ振る舞い」を回帰テスト**。
- どうしても dev で prod 相当を見たい人向けに `dev: 'coarse'`（毎回ルートから完全クロール、HMR は遅い）を
  後続マイルストーンで **opt-in** 提供。**既定 off で確定**。

> **dev インクリメンタル DCE の検討**：dev を避ける本当の壁は「負の情報の不完全性」ではなく
> **(a) インクリメンタル fixpoint 無効化の健全性**と **(b) HMR のモジュールグラフ乖離**である
> （コールサイト集合は import グラフ追跡ではなく FS 走査由来なので、完全性は build/dev で同条件）。
> Salsa 風の自動依存追跡（(a)）と `handleHotUpdate` の module widening（(b)）で opt-in 提供する
> 移行計画は [`RUST-MIGRATION.md`](./RUST-MIGRATION.md) を参照。

### 6.3 ソースマップ / プリプロセッサ順序 / TS

- 我々は元 `.vue` から **span を削除**する変換なので、magic-string で
  `shaken → original` のマップを生成 → 下流 Vue のマップと合成すれば元ソースでデバッグ可能。
- **TS を保持**：`<script setup lang="ts">` の型注釈（`defineProps<{...}>()` のジェネリック型引数を含む）は
  消さず、dead code だけ削る（`basic1` の期待出力も `lang="ts"` と prop 型を保持）。
  落とした prop は対応する型メンバ（`{ hasIcon: boolean }` の `hasIcon`）も連動して除去する。
  → スクリプト解析は **TS 対応パーサ**で行う（vize は TS ネイティブ、TS 経路が綺麗）。
- 我々は他のプリプロセッサ（TS トランスパイル等）より **前**＝著者ソースに最も近い段階で動く。
  prop の型・default を読め、出力も `.vue`(+TS) のまま保てる。

---

## 7. Engine 内部パイプライン（部分評価器の詳細）

1 コンポーネントの変換（`Engine.transform`）：

```
parse（SFC descriptor → script setup / template / style を AST 化）
  └ scope/semantic 構築（defineProps バインディング、テンプレート参照、used components）
        │
substitute：plan.removable + plan.constFold の prop を確定値に
  └ defineProps 分割代入の該当 prop を const に降格 → 署名（型メンバ含む）から落とす（既定：攻め）
  └ L1 で署名から落とした prop は、全コールサイトの該当属性も除去
       ・ただし属性式が副作用を持つ（例：:value="sideEffect()"）場合は属性を残す/式を保持
       ・bail 済みの rest props 経由（v-bind="rest"）は対象外なので、未知 prop 流入の心配なし
        │
constant fold（script → template → CSS class）
  └ v-if/v-else-if/v-else・ternary（mustache）・logical/文字列補間/:class の条件を畳む
  └ <x v-for="..." in []> / v-if="false" などを評価
        │
DCE（副作用・リアクティビティを尊重）
  └ 出力が未使用かつ副作用なしの computed / watch を除去
  └ 未使用宣言・未使用 import・未使用コンポーネント import を除去
  └ 死んだテンプレート分岐（v-if="false" 要素、到達不能 v-else）を除去
  └ 死んだマークアップ・集合外クラスに紐づく CSS ルールを除去（Vue では shaker 自前・§6.1）
        │
emit：スリム化した Vue SFC ソース + sourcemap
```

これを **コンポーネント内でも不動点反復**（畳み込みが次の畳み込みを生む）。

**v-if チェーンの畳み込み（Vue 固有の注意点）**：Svelte の `{#if}/{:else if}/{:else}` は 1 つの
ブロック構文だが、Vue の `v-if`/`v-else-if`/`v-else` は **隣接する兄弟要素**に分散したディレクティブで、
意味的に 1 本の分岐チェーンを成す。畳み込みでは：

- `v-if="false"` の要素を消したら、後続の `v-else-if`/`v-else` を**繰り上げる**（先頭 `v-if` が消えると
  最初の `v-else-if` が新しい `v-if` になる、等）。
- いずれかの条件が `true` 定数に畳めたら、それ以降の `v-else-if`/`v-else` 兄弟は到達不能として除去し、
  当該要素からは分岐ディレクティブを外して無条件描画にする。
- チェーンの同定は「直前の生きた兄弟が `v-if`/`v-else-if` を持つか」で行う（間にコメント/空白テキストが
  挟まっても連結性を保つ）。これは Svelte のブロック構文より careful な兄弟リンク管理を要する。

**実装手段の選択**：

- **削除主体**なので magic-string による **AST ノード span のサージカル削除**が頑健
  （整形を保ち、テキスト再構成の脆さがない）。
- 式を**書き換える**畳み込み（`` `btn-${variant}` `` → `btn-primary`）は置換で対応。
- Rust 版は vize の AST を直接変換し printer で再印字する経路も取れる（printer ベース。§9）。

---

## 8. TypeScript 実装（第一段階）

既存スキャフォールド（pnpm workspace）を踏襲：

```
packages/
  vue-shaker/                    … Engine（コア）。env 非依存
    src/
      parse/                     … @vue/compiler-sfc / @vue/compiler-dom ラッパ（→将来 vize）
      analyze/                   … クロール収集物 → PropProfile → fixpoint
      transform/                 … substitute / fold / dce / emit
      css/                       … 到達不能 CSS ルール除去（Vue では shaker 自前）
      ir.ts                      … §5.1 のデータ契約
      engine.ts                  … analyze() / transform()
  rollup-plugin-vue-shaker/      … Shell（Rollup）
  vite-plugin-vue-shaker/        … Shell（Vite。enforce:'pre'、2 パス、HMR ポリシー）
  example/                       … 動作確認・回帰フィクスチャ
```

- 第一段階は **L0 + L1**、`basic1` を緑にするところから。`@vue/compiler-sfc` の `parse()`
  （descriptor）・`compileScript`（`<script setup>` バインディング / `defineProps` 抽出）・
  `@vue/compiler-dom` の `baseParse()`（template AST）と `magic-string`、スクリプト解析に TS を使う。
- **本流は「直接 SFC-AST 部分評価器」**：テンプレート AST 上で v-if チェーン・mustache・`:class` を
  畳み、script setup 上で defineProps を畳む（§7）。

### 8.1 プラグイン API（案）

```ts
shaker({
  level: 0 | 1 | 2, // 既定 1
  include,
  exclude, // glob
  dev: false, // dev でも走らせるか（既定 false = build のみ）
  monomorphize: { maxVariants: 8, minSavings: 0.15 }, // L2 ガード
  unsafe: { allowRestProps: false }, // bail を緩める脱出口
  report: false, // 削減レポート（prop/branch/byte）を出力
});
```

**想定の実装サーフェス**（Vite `src/vite.ts` / Rollup `rollup-plugin-vue-shaker`）：

```ts
// L0/L1/L1.5（既定・挙動不変）
shaker({ include: ['.'] });

// L2 opt-in（level:2 かつ monomorphize が truthy のときのみ有効）
shaker({ include: ['.'], level: 2, monomorphize: true });
shaker({ include: ['.'], level: 2, monomorphize: { maxVariants: 16 } });
shaker({ include: ['.'], level: 2, monomorphize: { minSavings: 0.15 } }); // >=15% 純減を要求

// エンジン直叩き（Shell 非依存）
import { vueShakerWithMono } from 'vue-shaker';
const { files, mono } = await vueShakerWithMono(
  entries,
  resolve,
  readFile,
  { enabled: true, maxVariants: 8, minSavings: 0 }, // 既定 enabled:false
  (variantId) => `…`, // variant の import 先 specifier を組み立てる
);
// entries は net-win ゲートの到達ルート計算にも使われる（§3 L2）。
// mono.variants: id -> { code(residual), foldedProps } ／ mono.bindings: コールサイト割当て
```

`minSavings` は L2 のサイズガード（既定 0＝厳密純減のみ。§3 L2 / §13.2 の測定ベース net-win ゲート）。L2 の
ガードは **all-sites-or-nothing ＋ `Σ_spec < Σ_base * (1-minSavings)` ＋ dedup ＋ `maxVariants` cap**。
`exclude` / `unsafe` / `report` は API 予約（未実装）。

---

## 9. Rust（vize）への移行戦略

[vize](https://github.com/baseballyama/vize) は **arena ベース（`vize_carton` = bumpalo）の Vue ツールチェーン**で、
shaker に必要な部品が既に揃う。エンジン境界（§5.1 IR）を最初から固定しておけば、Engine 実装だけを差し替えられる。
vize は edition 2024 / Rust 1.95.0。

> **dev インクリメンタル DCE を最終ゴールに据えた移行計画**（バッチ境界化 → クエリ束化 → Rust 化 →
> dev opt-in）の詳細マイルストーンは [`RUST-MIGRATION.md`](./RUST-MIGRATION.md)。以下の表は
> その Stage A–C で差し替える Engine 部品の対応。

| shaker が必要とする処理            | vize の既存資産                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SFC のパース（descriptor）         | `vize_atelier_sfc`：`parse()` → `SfcDescriptor`（`SfcTemplateBlock`/`SfcScriptBlock`/`SfcStyleBlock`） |
| template の高速パース（AST）       | `vize_armature`：`parse()` → `RootNode`（template parser + tokenizer）                                 |
| AST ノード型                       | `vize_relief`：`RootNode`/`ElementNode`/`DirectiveNode`/`InterpolationNode`/`TemplateChildNode`        |
| script setup の意味解析            | `vize_croquis`：`defineProps` 型抽出（`TypeProperty`）・`BindingMetadata`・`used_components`・rest 検出 |
| 定数評価・畳み込み（制御フロー）   | `vize_croquis_cf`（control-flow / 定数畳み込み補助）                                                   |
| Vue ソース再生成・SSR オラクル     | `vize_atelier_ssr`（SSR codegen）/ `vize_atelier_sfc` の compile（再印字経路）                         |
| arena アロケーション               | `vize_carton`（`Allocator` = bumpalo `Bump` ラッパ。AST は arena 上）                                  |
| JS ↔ Rust の橋渡し（NAPI / WASM）  | `vize_vitrine`（`#[napi]` バインディング + `wasm-bindgen` WASM バインディング）                        |

**移行の順序（ホットパスから）：**

1. **パーサ + モデル抽出だけ Rust 化（Stage A）**：Shell/Engine は TS のまま、`parse`（SFC descriptor +
   template AST + defineProps/bindings 抽出）を vize に差し替え。全ファイルを舐めるクロールが最も重いので
   ここが効く。TS 実装との **differential parity**（同一フィクスチャで Rust モデル == TS モデルを byte/構造比較）で検証。
2. **解析（PropProfile + fixpoint）を Rust 化（Stage B）**：グラフ計算を Rust に移し、Shell は
   `this.resolve` の結果（解決済みパス）だけ渡す。モジュール解決は Vite 互換のため JS に残す。
3. **変換（fold + DCE + emit）を Rust 化（Stage C）**：`vize_croquis_cf`（畳み込み）+ printer 再印字。
   ここで「magic-string サージカル削除（TS 版）」から「AST 変換 + printer 再印字（Rust 版）」へ
   実装手段が自然に変わる。IR は不変なので Shell は無改修。

> モジュール解決（`this.resolve`）と Vite フックは **JS に残す**のが正解。
> エコシステム互換のため。Rust 化するのは「Vue を理解する純粋計算」だけ。

---

## 10. 実装手段の指針（直接 SFC-AST 部分評価器）

本流は §7 の **直接 SFC-AST 部分評価器**（テンプレート AST と script setup AST 上で定数評価・DCE を行う）。

- **避けるべきアンチパターン**：「Vue テンプレートを擬似 JS に変換 → JS tree-shaker → マーカー経由で
  SFC に戻す」方式は、整形・ネスト・`v-for`/scoped slot/`v-bind`/CSS を正しく往復させるのが脆く、
  span マッピングが破綻しやすい。テンプレート制御フロー（v-if チェーン・`v-for`）やリアクティビティ
  （computed/watch）・`:class`/属性補間の意味論を JS にエンコードしきれない。
- **採るべき方針**：JS の liveness モデルは「解析の補助」として使ってよいが、**テキスト復元には使わない**。
  すなわち — _「コンポーネントを liveness モデルに落として到達可能性/DCE を解き、その結果を
  元 AST のノード id 上の keep-set として引き戻し、出力は元 AST（printer / magic-string）から行う」_
  という **ハイブリッド**にすれば、解析の恩恵を得つつテキスト再構成の脆さを排除できる。
  → 元 AST が「真実の出力元」。

---

## 11. 実装状況（IMPLEMENTATION STATUS）

> 本節は「設計（§1–§10, §12, §13）が現行コードでどこまで実装されたか」の正直な棚卸し。
> 設計セクション自体は将来像も含むため残す。**本プロジェクトは svelte-shaker からの新規移植であり、
> TS エンジンが進行中の第一次成果物、Rust/vize 化は段階的に着手する。**

### IN PROGRESS（進行中・第一次成果物）

- **M0｜骨格**（進行中）：IR 確定（§5.1 / `src/ir.ts`）。Engine（`src/{parse,analyze,eval,dead,transform,css,index}.ts`）/
  Shell（`src/vite.ts`・`rollup-plugin-vue-shaker`）分離。`basic1` を L0/L1 で緑にするのが最初のゲート
  （新既定＝署名まで縮める）。dev は素通し（`apply:'build'`）。
- **M1｜実用 L0/L1 + 部分 bail**（計画）：whole-program fixpoint カスケード（`analyze.ts` + `dead.ts` の単一述語
  `decideChain`）、部分 bail フレームワーク（§4.1：`v-bind` 後勝ち・callee rest・`v-model`）、escape 解析
  （`<component :is="X">` 等）と barrel/named import の完全 bail（§4.2）、shadowing（scoped slot / `v-for` スコープ）
  ガード、call-site 属性除去（副作用式は保持）、より広い fold（mustache ternary、文字列補間、**v-if チェーン繰り上げ**）。
  magic-string によるサージカル span 削除。
- **M2｜L1.5 値集合ナローイング + CSS 自前除去**（計画）：`multi`（値集合）抽象、到達不能な
  v-if/v-else-if アームの除去（`eval.ts evaluateWithSets`、Kleene 三値・strict/loose 等価を区別）、
  **到達不能 CSS ルール除去**（`css.ts`、Vue では shaker 自前＝最大の differentiator・§6.1）。
  差分 SSR を健全性オラクルとする回帰（`tests/diff.ts`：comment 除去・空白正規化した
  `@vue/server-renderer` `renderToString` HTML の同値）。CSS ベンチ（control は `.btn-danger`/`.btn-ghost`
  を残すが shaken は除去）。adversarial soundness 群（`tests/{shadow,probes2}.test.ts`）。
- **L0 / L1 / L1.5 = 既定で有効、L2 = opt-in**（目標）：§3 の表のとおり。`level` 未指定でも挙動不変。

### REMAINING（未実装・後続）

- **L2 コールサイト・モノモーフィズ（opt-in、測定ベース net-win ゲート）**：エンジン `src/mono.ts`
  （生きたサイト × `v-bind="rest"` に上書きされ得ないリテラル prop のみ特殊化、residual は L0/L1/L1.5 と同一の
  `shakeBody` で生成）＋仮想モジュール配線（`?shaker_variant=<n>`）＋ residual dedup。**「絶対に肥大しない」
  ゲート**：(1) all-sites-or-nothing、(2) whole-program live render グラフの到達性を `ownSize`
  （`@vue/compiler-sfc` compile の `code.length`、メモ化）で測り、**`Σ_spec < Σ_base * (1 - minSavings)` の
  厳密純減のときだけ**特殊化（§3 L2 / §13.2）。`vueShakerWithMono(entries, …)` に **entries を通して**到達ルートを
  計算。`shaker({ level:2, monomorphize:true })` で有効化（既定 OFF）。L0/L1/L1.5 安定後に着手。
- **L2 フォローアップ**：(a) candidate 同士の**相互作用**を含めた厳密最適抽出（§13.2 の e-graph / ILP）、
  (b) gzip 後サイズや共有チャンク粒度を考慮したコストモデル、(c) Rollup 経路の L2 e2e テスト。
  `exclude` / `unsafe` / `report` の API は予約のみ（未実装）。
- **ベンチ・配布形態**：大規模デザインシステムでのベンチ、`.vue` ソース配布ライブラリでの実測、CI での
  「shake 有/無の prod ビルド同値」回帰の常設。
- **Stage A｜Rust 化①（パーサ + モデル抽出）**：`parse` を vize（`vize_atelier_sfc` + `vize_armature` +
  `vize_croquis`）に差し替え、TS 実装との **differential parity** で検証（§9-1 / RUST-MIGRATION §3）。**staged**。
- **Stage B｜Rust 化②（部分解析）**：解析（PropProfile + fixpoint）を Rust（vize）へ。Rust plans == TS plans を
  差分比較（§9-2）。**計画**。
- **Stage C｜Rust 化③（変換 + emit）**：`vize_croquis_cf` + printer 再印字へ（§9-3）。**計画**。
- **dev coarse / incremental モード**：影響部分グラフのみ再解析する HMR（§6.2、opt-in）。**計画**（dev は当面常に素通し）。
- **L1.5 高度化**：TS union literal 型からの値集合 seed・オブジェクトマップキー除去・§13 のフル
  IDE/SCCP/CFA（§12-8：縮約版の範囲確定が未決）。

---

## 12. 設計判断

### 決定済み

1. **対象 Vue API → `<script setup>` + `defineProps`/`withDefaults` 専用**。Reactive Props Destructure
   （`const { variant = 'primary' } = defineProps<...>()`、Vue 3.5+）または `withDefaults(defineProps(), {...})`
   のみ対象。実装・健全性解析が単純で、vize（`vize_croquis` の defineProps/bindings 抽出）の Rust 経路と一致する。
   Options API（`props: {...}` / `this.$props`）や素の `<script>` は対象外（将来の拡張余地として残すが
   初期はサポートせず素通し）。
2. **prop 宣言の扱い → 署名まで縮める（攻め）**。未使用／定数畳み済み prop は `defineProps` の destructure
   と型メンバから落とす。L1 では連動して全コールサイトの該当属性も除去（副作用を持つ属性式は保持）。
   → フィクスチャ `basic1/expected` を本既定に合わせて整備（宣言・型メンバ・`:has-icon="false"` 属性を削る）。

3. **値集合ナローイング（L1.5）→ 既定 ON**。「使わない variant を消す」を複製なしで実現する主力。
   束に `multi`（値集合）抽象を持たせ、到達不能な分岐・オブジェクトマップキー・CSS ルールを除去する。
4. **CSS 除去 → shaker が全責任を負う（Vue 固有・決定済み）**。Svelte と違い Vue コンパイラは未使用 CSS を
   刈らないので、到達不能ルール除去は vue-shaker の `css.ts` が所有する（§6.1）。これが Svelte 版を超える
   最大の差別化要因。
5. **dev の既定 → build-only で確定**（§6.2）。dev は素通し。`dev: 'coarse'` は後続で opt-in。
6. **spread / rest / v-model → 部分 bail を既定**（§4.1）。影響を prop 単位に局所化して救う。
   **defineExpose 公開 / customElement / escape のみ完全 bail**。

7. **値集合の上流追跡 → ヒューリスティック不要、§13 の原理的解析で確定**。「どこまで遡るか」は
   IDE による meet-over-all-valid-paths 精度で*解消*する（恣意的レベルを置かない）。
8. **L2 複製の判断 → `maxVariants`/`minSavings` を当て推量に使わず、§13 の原理的機構で確定**。
   変種は「相異なる residual 数」で内在的に有界、終了は WQO whistle、選択は測定コストの最適抽出。

### 未解決（要決定）

9. **§13 の理論をどこまで実装に落とすか**（フル IDE/CFA/supercompiler は重い）。
   対象が「prop＝引数・値はリテラル union」の分配的断片であることを使った*縮約版*の範囲確定。

---

## 13. 原理的アルゴリズム基盤（ヒューリスティック回避）

§3 の値集合ナローイング（L1.5）と L2 モノモーフィズは、`maxVariants`/`minSavings`/「追跡レベル」
のような恣意的ヒューリスティックを使わない。**両者は同一理論「抽象解釈に基づくポリバリアント特殊化
(polyvariant specialization by abstract interpretation)」の表裏**であり、確立アルゴリズムで形式的保証つきに解ける。

|                             | 何を決めるか                                 | 原理的機構                                                                           |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| **解析（L1.5 の値集合）**   | 各コンテキストで*何が静的に分かるか*         | Conditional Value-Set Analysis = IDE + SCCP + CFA、TS union で seed、widening で有界 |
| **特殊化（L2 の複製判断）** | _どのコンテキストに固有 residual を与えるか_ | 残余等価クラスタリング + WQO whistle/一般化 + コスト最適抽出                         |

### 13.1 値集合解析（問題：上流追跡をどこまでやるか → 解消）

1 つの定まった解析として実装する。「レベル」は置かない。

- **抽象ドメイン**：有限リテラル集合（[Value-Set Analysis, Balakrishnan & Reps] の特殊形）。
  join=和集合。**widening 上界は prop の TS union literal 型の濃度から導出**（型を超える値の仮定は
  そもそも unsound なので ⊤）。マジックナンバー不要。
- **条件付き（[SCCP, Wegman & Zadeck]）**：分岐到達可能性と値伝播を相互再帰で同時に解き、
  実行不能経路の値を集合に混ぜない（`variant∈{primary,secondary}` がタイトに出る）。`⊥`/集合/`⊤` の3層格子。
- **手続き間（[IDE, Sagiv-Reps-Horwitz]）**：prop=関数引数として境界・ローカル束縛・`v-for` スコープ変数・
  scoped slot props（`v-slot`）を貫き、**meet-over-all-valid-paths 精度・多項式時間**で伝播。copy/linear 断片は
  IDE 精度、非分配演算（文字列連結・算術）は健全に ⊤。→「行けるところまで正確に」行く。
- **高階 / escape**：`<component :is="X"/>` やコンポーネント値渡しは [k-CFA] / Andersen points-to で
  「X が取り得るコンポーネント集合」に解決し、bail せず特殊化対象にする。
- **フロンティアの seed**：解析が見通せない境界では TS union 型を型システムの MOVP として初期値に使う。
  `as`/`any`/非strict は ⊤（明示的 trust boundary）。

> 残るノブは「集合 widening 上界（型濃度から導出）」と「CFA 文脈深さ k」のみ。**いずれも単調＝
> 上げれば精密になるだけで決して unsound にならない健全性保証つき精度パラメータ**であり、
> 「正しさと無関係なサイズを当て推量で削る」ヒューリスティックとは性質が異なる。

### 13.2 特殊化の判断（問題：複製は得か → 測定 + 最適化）

- **複製数は内在的に有界（count ノブ不要）**：[Selective / Identifying Profitable Specialization,
  Dean-Chambers-Grove] と PE のメモ化（[Christensen & Glück]）に従い、**特殊化が*厳密に異なる*
  residual を生むコンテキストだけ複製し、同一 residual のコンテキストはクラスタリングして共有**。
  変種数＝「相異なる残余プログラム数」で意味的に有界（瓜二つコピーは構成的に発生しない）。
- **終了・肥大の保証**：再帰コンポーネントやカスケード特殊化の爆発は、**整礎順序(WQO)の
  homeomorphic embedding whistle + 最一般一般化(msg)**（[Leuschel]）が検知して安全に畳む。
  「N で打ち切り」を理論的に置換。
- **「複製は得か」は予測でなく測定**：候補 residual を自前 printer で実体化し**実サイズ
  （必要なら minify/gzip 後）を測定**、共有 vs 特殊化を **equality saturation / e-graph の
  コストベース最適抽出（[egg]、ILP 抽出）**で*厳密最小*に解く。`minSavings` の当て推量を、
  測れる目的関数に対する最適解へ置換。

### 13.3 実装上の縮約（現実解）

フルの supercompiler / k-CFA は重い。だが本ツールの対象は「prop＝関数引数、値はほぼリテラル union」
という*極めて素直な分配的断片*なので、理論の必要部分だけに絞れる：
**有限集合 IDE + SCCP 到達可能性 + 距離 k の `<component :is>` 解決 + residual 等価クラスタリング
+ embedding whistle**。Rust(vize) と相性良好（`vize_croquis` が参照/バインディング解析、
`vize_croquis_cf` が制御フロー、egg 系が e-graph を提供）。

### 参考文献

- Selective Specialization for Object-Oriented Languages — Chambers, Dean, Grove (PLDI'95)
  <https://dl.acm.org/doi/10.1145/223428.207119>
- Identifying Profitable Specialization in Object-Oriented Languages — Dean, Chambers, Grove
  <https://www.researchgate.net/publication/2819254>
- Precise Interprocedural Dataflow Analysis (IDE) — Sagiv, Reps, Horwitz
  <https://link.springer.com/chapter/10.1007/3-540-59293-8_226>
- Constant Propagation with Conditional Branches (SCCP) — Wegman & Zadeck
  <https://www.cs.utexas.edu/~pingali/CS380C/2010/papers/p291-wegman.pdf>
- DIVINE / Value-Set Analysis — Balakrishnan & Reps
  <https://link.springer.com/chapter/10.1007/978-3-540-69738-1_1>
- Improving Homeomorphic Embedding for Online Termination — Leuschel
  <https://link.springer.com/chapter/10.1007/3-540-48958-4_11>
- Controlling Generalization and Polyvariance in Partial Deduction — Christensen & Glück
  <https://dl.acm.org/doi/pdf/10.1145/271510.271525>
- egg: Fast and Extensible Equality Saturation — Willsey et al.
  <https://dl.acm.org/doi/pdf/10.1145/3434304>
