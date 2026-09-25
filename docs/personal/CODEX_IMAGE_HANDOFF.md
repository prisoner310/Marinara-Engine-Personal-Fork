# ChatGPT / Codex Image 私家改造メモ

この文書を、この私家改造の現在地を共有する正本とする。次の担当者は作業前にコードとGit状態を再確認し、実装・判断・テスト・次の課題が変われば作業後に更新する。ここには認証情報や実画像データを記載しない。

## 目的とGit構成

- 目的: Marinara Engineの通常のImage Generation Connectionで、既存の`codex login`によるChatGPT OAuthを使い、別のOpenAI Platform API Keyなしで画像生成・参照画像編集を利用する。
- 作業branch: `personal/codex-image`。`origin`は個人fork `prisoner310/Marinara-Engine-Personal-Fork`、`upstream`は公式 `Pasta-Devs/Marinara-Engine`。個人branchだけに通常pushし、公式側へのpush・PRはしていない。
- 履歴: Phase 1 `ec3ab4bcc`（OAuth画像接続）、Phase 2A `1a4b0cf74`（参照画像編集）。いずれも公式mainの `12a0acd5b` を基点とする個人branch上のコミット。
- **最後に確認した実装commit（このメモ作成直前）:** `1a4b0cf741df1e2198f8f1688102ea7e5253468c`。この文書自身を含む最新コミットは `git log -1` で確認する。

## 実装済みと実画像の確認状況

- **Phase 1:** `ChatGPT / Codex Image`をConnectionsから選択できる。API Key・Base URL入力不要、モデルは **GPT-Image 2 (`gpt-image-2`) 固定**。`generateImage()`から1枚のText-to-Imageを生成し、PNG base64を既存の画像結果・Gallery保存処理へ渡す。Test Connectionはローカルログインだけを検査し、画像利用枠を使わない。
- **Phase 2A:** 当初予定されていた`referenceImage` / `referenceImages`対応は**実装済み**。参照なしは`/images/generations`、参照ありはJSON形式の`/images/edits`。生base64と画像data URLを受け、順番を保って重複を除く。異なる参照画像が6枚以上なら送信前に明示的なエラーにする。
- **実画像:** ユーザーはPhase 1の **Test Image成功**を報告し、Phase 2A指示にはGallery保存も確認済みとある。**参照画像1枚を使う実Image Editは未確認**。自動テストでは実アカウントを使っていない。

## 現在の画像生成経路と設計判断

`Image Generation Connection (codex_chatgpt)` → `generateImage()` → `openai-chatgpt-image.ts` → 既存OAuth helper → `safeFetch` → ChatGPT Codex画像endpoint → `data[0].b64_json` → PNGの`ImageGenResult` → 既存の保存処理。

- 認証は既存の`getOpenAIChatGPTAuth()`と`buildOpenAIChatGPTHeaders()`を再利用する。画像ごとにCodex CLIを起動しない。接続固有のURL・request・response変換は小さなadapterに閉じ込め、DB migrationと保存方式の変更を避ける。
- ChatGPT Codexのbase URLは `https://chatgpt.com/backend-api/codex`。`x-codex-image-turn-id`を付け、`safeFetch`のHTTPS制限を維持する。認証情報・参照画像base64をログやエラー文へ出さない。外部画像URLを取得しない。
- promptとnegative promptの組み立て、OAuth header、レスポンス解析、HTTPエラー変換はgeneration/editで共通。model=`gpt-image-2`、background=`opaque`、quality/size=`auto`、出力は1枚のPNG。
- 既存のOpenAI Platform画像接続は別実装。GPT-Image 2.5はPlatform側にあっても、この接続では**Codex側が画像モデルの明示選択を提供するまで保留**し、モデルIDだけを推測して切り替えない。
- Codexの画像経路は内部仕様なので更新時に再確認する。2026-09-25に確認したCodex main: [built-in画像ツール](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)、[画像API endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)。そこでもモデルは`gpt-image-2`、参照上限は5枚、生成と編集は別endpoint。

## 制約と次の課題

- 実Image Editの最終確認が残る。既存アバターのあるキャラクターで「Generate Character Avatar」→ ChatGPT / Codex Image →「Use current avatar as a reference」→短い変更指示→ **Generateを1回**。プレビューを確認し、元画像を残すなら採用せず閉じる。
- generation IDを使った再編集、mask、透明背景UI、quality/size UI、モデル選択、複数出力は未対応。6枚以上の参照画像を自動選択せず、エラーで知らせる。
- **Phase 2B候補:** シーンに出るキャラクターの画像を自動参照する際の優先順位と5枚制限。既存の`game.routes.ts`は`collectIllustrationCharacterAssets()`で登場人物の参照画像を集め、`illustrator-references.ts`は設定されたcharacter sheet、avatar、spriteの順で候補を読む。背景の場所画像も先に入る場合がある。シーン側のprovider別上限はCodex固有に調整されていないため、6枚以上では現在のadapterが明示的に拒否し得る。これらのシーン処理はPhase 2Aでは変更していない。
- **さらに先の候補:** generation IDによる連続編集、mask、透明背景、quality/size設定、複数出力。GPT-Image 2.5の検討はCodex側の明示的なモデル選択を確認してから行う。
- 起動時更新で未追跡のadapterが消えた過去の報告がある。現在のadapterは個人branchに追跡・push済み。起動や更新後、branchと`git status`を確認する。

## 主なファイルとテスト

| ファイル | 役割 |
| --- | --- |
| `packages/server/src/services/llm/openai-chatgpt-auth.ts` | 既存のCodex ChatGPTログイン取得・更新 |
| `packages/server/src/services/image/openai-chatgpt-image.ts` | generation/edit切替、参照変換、HTTP、PNG結果・安全なエラー |
| `packages/server/src/services/image/image-generation.ts` | 共通`generateImage()`からadapterへ振り分け |
| `packages/shared/src/constants/model-lists.ts` | Connectionのサービス名と固定モデル |
| `packages/server/src/routes/connections.routes.ts` | 接続テストとモデル一覧 |
| `packages/client/src/components/connections/ConnectionEditor.tsx`・`packages/client/src/localization/locales/en.json` | 接続画面と説明 |
| `scripts/regressions/codex-chatgpt-image.regression.ts`・`e2e/codex-chatgpt-image.e2e.ts` | mock回帰と接続画面e2e |
| `docs/media/image-providers.md` | 利用者向け手順 |

- Phase 2A時点の結果: `pnpm check`成功（build・型検査・lintを含む。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像mock回帰成功、既存OpenAI GPT Image回帰成功、接続画面e2eはdesktop Chromium / mobile Chromium / mobile WebKitの3件成功。
- mockは合成画像・合成認証情報のみを使う。Test Connectionは画像を生成しないが、**Test Imageと手動Editは実際に画像利用枠を使う**。
- このWindows環境ではリポジトリ指定のpnpm 10を`corepack pnpm`で使用。Playwrightブラウザが未導入なら別途導入が必要で、サンドボックス内のブラウザ起動は`EPERM`になった。テスト本体の失敗と環境起因の起動失敗を区別する。
