# Rust 版エンジン（vize）+ dev インクリメンタル DCE 移行設計

> 本書は [`ARCHITECTURE.md`](./ARCHITECTURE.md) §5（Shell/Engine/IR 層構造）と §9（Rust 移行戦略）を
> 「dev インクリメンタル DCE を最終ゴールに据える」前提で具体化したもの。`ARCHITECTURE.md` が
> *何を / なぜ* なら、本書は *どう移行するか* を扱う。Rust 中核は [vize](https://github.com/baseballyama/vize)
> （arena ベースの Vue ツールチェーン、edition 2024 / Rust 1.95.0）を用いる。

## 1. 動機

vue-shaker は **TypeScript 実装・`vite build` 限定**を第一次成果物とし、dev は素通し（§6.2）で立ち上げる。
2 つの観察が本移行の前提になっている。

### 1.1 境界オーバーヘッドは小さい（Rust 化が素直）

shake は `buildStart` の**ワンショット**バッチ（`src/vite.ts` の `buildStart`）で完結し、`transform`
フックは `shaken[file]` を**引くだけ**で済む設計にする。境界を越えるのは **AST ではなくスリム化済みソース文字列**で、
AST はエンジン内部で生成・消費されて閉じる（`transformAll` は `Record<ComponentId, string>` を返す）。

→ Rust（NAPI / WASM、vize は `vize_vitrine` が両方を提供）化しても **ホットな AST 往復は原理的にゼロ**。
境界を越えるのは「ソース文字列 + 解決済みグラフ JSON」in /「ソース文字列」out のみ。これは §5.1 の IR が
JSON シリアライズ可能に設計されている狙いそのもの。

唯一の注意点は、`analyze(entries, resolve, readFile)` がクロール中に `resolve`/`readFile` を
**per-edge コールバック**で呼ぶこと（in-process なら無料だが Rust→JS だと N+1）。
→ **JS 側で全解決してから Rust に 1 バッチ**で渡す形（§5.1 `AnalyzeInput`）に作る。

### 1.2 dev インクリメンタル DCE は技術的に可能

コールサイト集合は import グラフ追跡ではなく `collectVueFiles` の **FS ディレクトリ走査**
（`src/scan.ts`）で作る。よって「負の情報（その値は存在しない）」の完全性は
「Vite が何をロードしたか」ではなく「`include` がディスク全体を覆うか」だけに依存する
— これは build/dev で同条件。

→ §6.2 が dev を避ける**本当の壁**は「負の情報の不完全性」ではなく、次の 2 点:

- **(a) インクリメンタル fixpoint 無効化の健全性** — カスケード（§2.1）の依存を取りこぼすと
  stale plan ＝無音破壊。
- **(b) HMR のモジュールグラフ乖離** — コールサイト編集（App.vue）が、無編集の子（Button.vue）の
  residual を変える。

両方とも既知の解法がある（前者 = Salsa 風の自動依存追跡、後者 = `handleHotUpdate` の module widening）。

## 2. アーキテクチャ

### 2.1 バッチ境界（callback-free）

エンジンは「**Extract → (JS で解決) → Analyze**」の 2 バッチ呼びにする。`this.resolve` は非同期で
Vite エコシステム互換のため JS に残す（§5/§9）。

```
Call A  extract(files)  → { edges: [{ from, specifier, kind }] }   // 構造スキャン、fixpoint なし
        ↓  JS が this.resolve で全 specifier を解決、barrel 多段は次バッチで閉じる（実測 1–2 ラウンド）
Call B  analyze(AnalyzeInput) → ShakeOutput
        AnalyzeInput = { files, edges(解決済み), entries, options }
        ShakeOutput  = { files: Record<id, slimmedSrc>, variants, bindings, diagnostics }
```

`kind` は `default-vue | named | namespace | barrel`。`ShakeOutput.files` は `transformAll` と byte 一致。

dev は**長命の `ShakerEngine` インスタンス**（NAPI class、`vize_vitrine`）に状態を保持させる:

```
class ShakerEngine {
  init(input: AnalyzeInput): ShakeOutput
  applyEdit(edits: FileEdit[]): EditResult
  applyGraphChange(delta: GraphDelta): EditResult
}
EditResult = { changed: Record<id, src>, removedVariants: string[], newVariants: Variant[], diagnostics }
```

`changed` は**スリム化出力が実際に変わった id 集合**（編集ファイルの上位集合）。

### 2.2 Salsa 風クエリ束（エンジン内部）

`buildModel`（モノリシック・解決を内包）を **`parse(id)` 起点の per-field 純関数**へ分解する。
`parse(id)` は §9 のとおり SFC descriptor（`vize_atelier_sfc` 相当）+ template AST（`vize_armature` 相当）+
script setup bindings（`vize_croquis` 相当）の 3 つを返す。

| 種別 | クエリ |
|---|---|
| 入力(input) | `source_text(id)`, `file_set()`(=FS スキャン), `entries()`, `options()`, `resolved(importer,spec)` |
| per-file 派生 | `parse`, `imports`, `prop_decls`(defineProps), `child_calls`, `local_bails`, `shadow_set`(scoped slot / v-for), `escaped_from`, `barrel_children_of` |
| 全プログラム派生 | `program_escaped`, `program_barreled`, `is_bailed`, **`importers_of`**(逆グラフ・派生), **`program_plans`**, `plan(id)`(射影), `dead_spans`, `dropped_props`, `transform`, `mono`(build-only) |

設計上の 3 原則:

1. **fixpoint（カスケード §2.1）は単一の `program_plans()` クエリ内で収束まで回す**（analyze の
   ループそのまま）。Salsa から見れば非循環。`plan(id)` を**値比較可能な射影**として分離し、
   **backdating**（出力が等しければ伝播停止）で `transform(id)` の granularity を回復する。
   Salsa cycle は使わない（共有 leaf コンポーネントで SCC がプログラム全体に膨張し利得ゼロ・リスク大）。
2. **逆依存の完全性 = 健全性の鍵**。`program_plans()` の fixpoint body は `file_set()` の**全ファイル**について
   `child_calls(f)`/`prop_decls(f)` を読むので、「全 importer に依存」が**構造的に自動・完全**に記録される。
   逆グラフ `importers_of` は**必ず派生クエリ**（手動メンテの Map は禁止 — 取りこぼし＝無音破壊）。
3. **述語スキューの禁止**。`dead_spans(id)`（`decideChain`/`computeDeadSpans`、v-if チェーン繰り上げ含む）を
   `transform(id)` と fixpoint の両方が**同一クエリ**として消費（`dead.ts` の「one predicate, two consumers」を維持）。

## 3. マイルストーン

> 順序は §9（パーサ先）ではなく**アーキテクチャ先**に意図的に変更。バッチ化 + クエリ分解が、
> 安い境界と dev インクリメンタルの**共通の土台**だから。難所（インクリメンタル無効化の健全性）は
> 言語非依存で、既存テスト資産のある TS で先に潰すのが最も安い。各 M はテスト緑を維持して独立に検証可能。
> Rust 経路は **Stage A（パーサ + モデル抽出）→ Stage B（部分解析）→ Stage C（変換 + emit）** の順で段階導入する。

- **M1（TS・純リファクタ）バッチ IR + クエリ分解**
  - `buildModel` を per-field 純関数に分解。解決は `AnalyzeInput.edges`（解決済み）から引く形に。
    `crawl`/`resolveThroughBarrel` の per-edge `resolve` を撤去。
  - `importers_of`/`program_plans()`/`plan(id)`/`dropped_props(id)` を明示関数として実体化。
  - Shell（`vite.ts buildStart`）を「Extract→JS 解決→Analyze バッチ」へ。
  - **ゲート**: 既存テスト全緑かつ出力 **byte 一致**（`vueShaker` と新バッチ経路の差分ゼロ）。

- **M2（TS・dev インクリメンタル試作 + オラクル）**
  - 軽量な依存追跡レイヤ + 長命エンジン状態。`configureServer` + `handleHotUpdate` の dev plugin。
  - **HMR module widening**: `changed` の各 id → `server.moduleGraph.getModulesByFile(id)`
    （main + `?vue&type=style/script` サブリソース）を `invalidateModule` し、`handleHotUpdate` から
    widen した ModuleNode 配列を返す。L2 variant 仮想モジュールは `getModuleById` で無効化。
  - add/remove/import 編集は watcher + Extract 再実行で `file_set()`/edges を**同期更新してから**エンジンへ。
  - **dev 差分オラクル**: 各編集後に「インクリメンタル == フルバッチ再解析」を byte 一致でアサート +
    既存差分 SSR オラクル（`tests/diff.ts`、`@vue/server-renderer` `renderToString` + SSR compile）を
    dev-served 出力にも適用。
  - 公開 API: `dev: false | 'coarse' | 'incremental'`（既定 `false`）。`'coarse'` = 毎編集フル再解析（安全弁）。
  - **ゲート**: dev 差分オラクル緑。`dev:false` で挙動不変。

- **Stage A / M3（Rust ①）vize パーサ + モデル抽出で TS エンジンを駆動（differential parity で検証）** —
  `parse`（SFC descriptor + template AST + defineProps/bindings 抽出）を vize（Rust/arena）に
  差し替えても TS エンジン（解析+変換）が**同一の shake 出力**を出すことを実証する。
  - **seam**: 新規プラグインを足さず、既存の `ParseCache` をパーサ注入点として使う（`analyzeInput(input, cache)` に
    vize の SFC descriptor / template AST / bindings を seed すると、エンジン全体が vize モデルで動く）。vize は
    公開 WASM/NAPI パッケージ（`vize_vitrine` の WASM 出力、devDependency、出荷エンジンは未参照）を `initSync` で読み込む。
  - **使う vize 部品**: `vize_atelier_sfc`（`parse()` → `SfcDescriptor` / `SfcTemplateBlock` / `SfcScriptBlock` /
    `SfcStyleBlock`）、`vize_armature`（`parse()` → `RootNode` template AST）、`vize_croquis`（`defineProps` 型抽出
    `TypeProperty`・`BindingMetadata`・`used_components`・rest 検出）、`vize_relief`（`ElementNode`/`DirectiveNode`/
    `InterpolationNode` ノード型）、arena は `vize_carton`（`Allocator`）。
  - **検証（differential parity）**: 全ゴールデンフィクスチャを vize 駆動で回し `@vue/compiler-sfc` 駆動と file 単位で
    比較。byte 完全一致を目標とし、既知差分（下記）は SSR 等価でガード（`tests/vize-diff.test.ts`）。
  - **既定は `@vue/compiler-sfc` のまま**。vize は differential オラクルで検証する Rust 経路として導入し、default flip は
    下記ブロッカー解消後（Stage B/C で恒久 differential オラクルとして常設）。
  - **default flip のブロッカー候補（vize 上流で要確認）**:
    1. **TS 型ノードの粒度** — `defineProps<{ x: boolean }>()` の inline 型注釈を `vize_croquis` の `TypeProperty`
       抽出がメンバ単位で精密に出すか確認する。落とした prop の型メンバ除去（`transform.ts removeTypeMember`）が
       member-level に依存するため。粒度不足なら死んだ型テキストが残る（compile で消えるので挙動は健全、byte のみ差分）。
    2. **`parse` の wrapper 再エクスポート** — `vize_vitrine` の NAPI/WASM 出力が SFC `parse` と template `parse` を
       JS から直接呼べる形でエクスポートしているか確認する。WASM 経路（`wasm-bindgen`）が確実な初期経路。
  - **ゲート**: differential parity 緑（byte 一致 + 既知差分が SSR 等価）。既存テスト全緑・`dev:false` 挙動不変。

- **Stage B / M4（Rust ②）解析を Rust → WASM へ（differential オラクルで段階検証）**
  - **配布形態 = WASM（決定済み）**: `vize_vitrine` の WASM 出力と同方式。Rust エンジンは **vize の重い codegen 非依存・
    自己完結**（JS が parse → AST JSON を WASM に渡す → Rust は `serde_json` で解析、AST は `vize_carton` arena 上）。
    重いコンパイラ crate 依存・git dep・ネイティブ prebuild infra を回避し、クロスプラットフォーム単一 `.wasm`。
    `wasm-pack --target nodejs`（Node ビルド時に同期ロード、init 不要）。crate は `packages/vue-shaker/engine-rs/`、
    成果物 `pkg/` は **commit**（CI はツールチェーン不要で committed wasm をロード）。
  - **段階検証**: 解析は `plans`（§5.1 IR）を出すので **Rust plans == TS plans を差分比較**できる。スライスごとに
    移植 → TS と差分比較 → 緑、を繰り返す（Stage A と同じオラクル手法）。
  - **per-file `FileModel` を先に完全移植**（全フィクスチャの実グラフ + 実 Vue 構文で **Rust == TS** を担保）:
    宣言 props（defineProps destructure / withDefaults）、`hasRestProp`、テンプレートバインディング収集
    （scoped slot / `v-for` で shadow される名・fold-blocked 名、再帰的パターン名抽出）、
    `defineExpose`/`defineCustomElement` bail、子コールサイト収集（解決済み edge から imports 再構築 + span。
    `:bind` / 静的属性 / `v-bind="rest"` / `v-model` の区別）、barrel 子 id 収集、escaped component 収集
    （`<component :is="X">` の値文脈含む）。続いて **whole-program 集約**（call-site 値集合束 join・fixpoint
    カスケード・部分 bail・dead span）→ `plans` 全体を TS と差分比較。これは小分けしにくい **cohesive な大スライス**
    （`readCallSite` + `valueSetFor` + `buildPlan` + `buildUsage`/fixpoint + `computeDeadSpans`/`decideChain` + `eval`）。
    実装上の要点:
    - **`Literal` は Rust enum**（`Str`/`Num`/`Bool`/`Null`/**`Undefined`**）にする必要がある。`undefined` は JSON で
      保持できず（prop default の `undefined` と `null` を区別する）、env は **Rust 内部で構築**される（call-site +
      default の join）ので serde_json::Value では表現不能。
    - **`eval` は JS 演算子セマンティクスの忠実エミュレーション**が健全性の核心（`==`/`!=` の型強制、`+` の
      string/number 分岐、strict/loose 等価、Kleene 三値の `evaluateWithSets`）。`eval.test.ts` で単体検証可能だが
      env を Rust 内部で組むため、検証は whole-program 一体で「`plans` == TS plans」を見るのが素直。
    - fixpoint は単調収束（`analyze.ts` の `MAX_FIXPOINT_ITERATIONS` ループをそのまま移植）。
  - **Vue 固有の注意点**: `<style scoped>` の到達不能ルール除去は Vue では shaker 自前（ARCHITECTURE §6.1）なので、
    CSS 関連の plan フィールド（集合外クラス → 除去対象セレクタ）も Rust に移植し differential 比較に含める。
    Svelte と違いコンパイラ任せにできない点が plan の対象範囲を広げる。
  - **将来**: 解析全体が揃ったら Salsa db 化（`program_plans` fixpoint・`plan(id)` 射影・`importers_of` 派生、
    AST ノードは安定 id で interning。vize の arena 上ノードに安定 id を振る）。**ゲート**: Rust plans == TS plans
    （全フィクスチャ）。TS エンジンを恒久 differential オラクルとして残す。CI に `cargo test` + `build:wasm`
    （pinned toolchain 1.95.0）ジョブ追加は follow-up。

- **Stage C / M5（Rust ③）変換 + emit を Rust へ** — `vize_croquis_cf`（制御フロー / 定数畳み込み）+
  DCE + printer 再印字（`vize_atelier_sfc` の compile / 再印字経路、SSR オラクルは `vize_atelier_ssr`）。
  `magic-string` サージカル削除 → AST 変換 + printer。`TransformResult.map` を実体化。
  **ゲート**: フル Rust エンジンで build 出力 byte 一致 + 差分 SSR 等価。

- **M6 dev インクリメンタルを Rust エンジン上で配線** — 長命 `ShakerEngine` を `vize_vitrine` NAPI で公開、
  M2 の dev Shell を接続。**ゲート**: dev 差分オラクル（Rust）緑。`dev:'coarse'` を安全弁として常設。

## 4. 健全性戦略

dev で素通しの安全性を捨てる代償への防御:

1. **コールサイト集合を常に完全に保つ** — 起動時フル FS スキャン + watcher 駆動の add/remove/edge 更新。
   §6.2 の「lazy load で負の情報が不健全」を、起動時フルクロール 1 回で回避。
2. **保守的な over-invalidation** — `changed` は性能ヒントであり正しさの境界ではない。迷えばカスケード閉包の
   上位集合を無効化（fixpoint は単調なので閉包は有限・well-defined）。under-invalidation のみが stale UI を生む。
3. **二重の差分オラクル** — (a) インクリメンタル == フルバッチ再解析（byte）、(b) 差分 SSR 等価。
   さらに TS エンジンを Rust の恒久リファレンスとして残す（Stage A–C 通して differential parity を維持）。
4. **opt-in・既定 off** — `dev:false` 既定維持。`'coarse'` を安全弁として常設。

## 5. リスクと決定事項

- **逆依存の取りこぼし = 無音破壊**（最重要）: `importers_of` は派生クエリ厳守、fixpoint は `file_set()` 全件読み。
- **`@vitejs/plugin-vue` との dev 順序**: 両者が `handleHotUpdate` でモジュール配列を返す競合。`shaken` 更新を
  plugin-vue の transform 再実行より前に。plugin 順序の統合テストで担保。
- **サブリソース（`?vue&type=style`）**: 無効化時に CSS サブリソースも含めて無効化（L1.5 CSS 除去は
  `type=style` 側。Vue では shaker が CSS を自前除去するため `type=style` 出力も shaken に依存）。build の skip ガードと対称に。
- **L2 の dev は当面しない**: 仮想モジュール + 純減ゲート（ホールプログラム測定）をインクリメンタルに保つのは
  高コスト。dev は L0/L1/L1.5 のみと文書化。
- **sourcemap**: Stage C まで dev のマップは近似。`TransformResult.map` 実体化で解消。
- **未ロードモジュールの ModuleNode 不在**: `shaken` 更新は ModuleNode の有無と独立に常に行う。
- **vize 上流との同期**: vize は活発に進化する（version 0.163 系・edition 2024）。Stage A の seam を
  WASM パッケージ境界に固定し、vize の内部 API 変更を吸収する。differential parity が回帰検知の安全網。
