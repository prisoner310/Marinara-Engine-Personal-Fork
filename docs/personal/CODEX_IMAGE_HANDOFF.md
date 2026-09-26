# ChatGPT / Codex Image 私家改造メモ

この文書を、この私家改造の現在地を共有する正本とする。次の担当者は作業前にコードとGit状態を再確認し、実装・判断・テスト・次の課題が変われば作業後に更新する。ここには認証情報や実画像データを記載しない。

## 目的とGit構成

- 目的: Marinara Engineの通常のImage Generation Connectionで、既存の`codex login`によるChatGPT OAuthを使い、別のOpenAI Platform API Keyなしで画像生成・参照画像編集を利用する。
- 作業branch: `personal/codex-image`。`origin`は個人fork `prisoner310/Marinara-Engine-Personal-Fork`、`upstream`は公式 `Pasta-Devs/Marinara-Engine`。個人branchだけに通常pushし、公式側へのpush・PRはしていない。
- 履歴: Phase 1 `ec3ab4bcc`（OAuth画像接続）、Phase 2A `1a4b0cf74`（参照画像編集）、共有メモ追加 `31776fbd0`。公式mainの `12a0acd5b` を基点とする個人branch上のコミット。
- **最後に確認した基点commit SHA:** `31776fbd0`。Phase 2A.5を含む現在のHEADは `git log -1` で確認する。

## 実装済みと実画像の確認状況

- **Phase 1:** `ChatGPT / Codex Image`をConnectionsから選択できる。API Key・Base URL入力不要、モデルは **GPT-Image 2 (`gpt-image-2`) 固定**。`generateImage()`から1枚のText-to-Imageを生成し、PNG base64を既存の画像結果・Gallery保存処理へ渡す。Test Connectionはローカルログインだけを検査し、画像利用枠を使わない。
- **Phase 2A:** 当初予定されていた`referenceImage` / `referenceImages`対応は**実装済み**。参照なしは`/images/generations`、参照ありはJSON形式の`/images/edits`。生base64と画像data URLを受け、順番を保って重複を除く。異なる参照画像が6枚以上なら送信前に明示的なエラーにする。
- **Phase 2A.5:** `transparentBackground=true`を`background="transparent"`へ、false/省略を`"opaque"`へ変換する。正の安全な整数のwidth/heightが両方あれば`"WIDTHxHEIGHT"`、なければ`"auto"`を生成と編集の両方へ送る。Spriteは**Codex接続の場合だけ**ネイティブ透過経路を選び、透過要求時のpromptからクロマキー指示を外す。通常のOpenAI Platform `gpt-image-2`の非対応判定と他providerのクロマキーfallbackは維持する。
- **ユーザーの実機確認済み:** Phase 1のTest ImageとGallery保存、参照画像1枚のImage Edit、バストアップ参照から全身Character Sheet、参照画像を使った表情差分Sprite。さらにCodex接続でpromptに背景透過を指示したPNGを生成し、CLIP STUDIO PAINTでalpha channelの透過を確認した。**Phase 2A.5の新しい`background="transparent"`送信と実サイズ指定はまだ実機未確認。**
- 上記alphaは**現在のChatGPT / Codex経路で観測された事実**。GPT-Image 2そのものの公式alpha対応やCodex内部での実モデルへのルーティングは確定していない。自動テストでは実アカウントを使っていない。

## 現在の画像生成経路と設計判断

`Image Generation Connection (codex_chatgpt)` → `generateImage()` → `openai-chatgpt-image.ts` → 既存OAuth helper → `safeFetch` → ChatGPT Codex画像endpoint → `data[0].b64_json` → PNGの`ImageGenResult` → 既存の保存処理。

- 認証は既存の`getOpenAIChatGPTAuth()`と`buildOpenAIChatGPTHeaders()`を再利用する。画像ごとにCodex CLIを起動しない。接続固有のURL・request・response変換は小さなadapterに閉じ込め、DB migrationと保存方式の変更を避ける。
- ChatGPT Codexのbase URLは `https://chatgpt.com/backend-api/codex`。`x-codex-image-turn-id`を付け、`safeFetch`のHTTPS制限を維持する。認証情報・参照画像base64をログやエラー文へ出さない。外部画像URLを取得しない。
- promptとnegative promptの組み立て、OAuth header、レスポンス解析、HTTPエラー変換はgeneration/editで共通。model=`gpt-image-2`、quality=`auto`、出力は1枚のPNG。MEのnegative promptは専用parameterではなく、`Do not include: ...`という自然文でmain promptへ追記する。
- Spriteのprompt reviewと実生成は同じ接続種別付きの計画を使う。Codexのネイティブ透過要求には`#00FF00`等を入れず、他providerには従来のfallbackを残す。返った画像に既にalphaがある場合、既存の`alreadyTransparent`判定を背景除去エンジンの選択より先に行い、AIエンジンを明示した場合も画像を保護する。
- 既存のOpenAI Platform画像接続は別実装。GPT-Image 2.5はPlatform側にあっても、この接続では**Codex側が画像モデルの明示選択を提供するまで保留**し、モデルIDだけを推測して切り替えない。
- Codexの画像経路は内部仕様なので更新時に再確認する。2026-09-26に確認したCodex main: [built-in画像ツール](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)、[Images request型](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/images.rs)、[画像API endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)。モデルは`gpt-image-2`、参照上限は5枚、生成と編集は別endpoint。request型は両方で`background=transparent`と文字列の`size`を許容するが、任意サイズをbackendが受理する保証ではない。

## 制約と次の課題

- 実機で透過ONのSpriteを1枚、サイズ指定のCharacter AvatarかCharacter Sheetを1枚だけ確認する。出力PNGのalpha、実pixel寸法と要求寸法を比較する。Codex backendが特定サイズを拒否した場合、エラーを調べてから対応し、自動で別サイズに再送しない。生成にはChatGPT/Codex利用枠を使う。
- Spriteの小さいキャンバス等、backendが受け付けるサイズ範囲は実機未確定。Codex Images request型の`String`は任意サイズの受理を保証しない。
- generation IDを使った再編集、mask、quality UI、モデル選択、複数出力は未対応。6枚以上の参照画像を自動選択せず、エラーで知らせる。
- **Phase 2B候補:** シーンに出るキャラクターの画像を自動参照する際の優先順位と5枚制限。既存の`game.routes.ts`は`collectIllustrationCharacterAssets()`で登場人物の参照画像を集め、`illustrator-references.ts`は設定されたcharacter sheet、avatar、spriteの順で候補を読む。背景の場所画像も先に入る場合がある。シーン側のprovider別上限はCodex固有に調整されていないため、6枚以上では現在のadapterが明示的に拒否し得る。これらのシーン処理はPhase 2Aでは変更していない。
- **さらに先の候補:** generation IDによる連続編集、mask、quality設定、size調整、複数出力。GPT-Image 2.5の検討はCodex側の明示的なモデル選択を確認してから行う。
- 起動時更新で未追跡のadapterが消えた過去の報告がある。現在のadapterは個人branchに追跡・push済み。起動や更新後、branchと`git status`を確認する。

## 主なファイルとテスト

| ファイル | 役割 |
| --- | --- |
| `packages/server/src/services/llm/openai-chatgpt-auth.ts` | 既存のCodex ChatGPTログイン取得・更新 |
| `packages/server/src/services/image/openai-chatgpt-image.ts` | generation/edit切替、参照・透過・サイズ変換、HTTP、PNG結果・安全なエラー |
| `packages/server/src/services/image/image-generation.ts` | 共通`generateImage()`からadapterへ振り分け |
| `packages/server/src/routes/sprites.routes.ts`・`packages/server/src/services/image/sprite-background.service.ts` | 接続別透過判定、Sprite prompt、alpha画像の背景除去skip |
| `packages/shared/src/constants/model-lists.ts` | Connectionのサービス名と固定モデル |
| `packages/server/src/routes/connections.routes.ts` | 接続テストとモデル一覧 |
| `packages/client/src/components/connections/ConnectionEditor.tsx`・`packages/client/src/components/ui/SpriteGenerationModal.tsx` | 接続画面とSpriteの透過警告 |
| `scripts/regressions/codex-chatgpt-image.regression.ts`・`scripts/regressions/sprite-background.regression.ts`・`e2e/codex-chatgpt-image.e2e.ts` | mock HTTP、背景、接続画面とSpriteプレビューの回帰 |
| `docs/media/image-providers.md` | 利用者向け手順 |

- Phase 2A.5時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像、Sprite背景（alpha PNGが強制AI背景除去を回避する検証を含む）、GPT-Image 2.5、画像custom parameters、画像サイズ制限の回帰は全件成功。Codex接続画面e2eはdesktop Chromium / mobile Chromium / mobile WebKitの3件成功。Spriteプレビューe2eも同3環境で3件成功。
- mockは合成画像・合成認証情報のみを使う。Test Connectionは画像を生成しないが、**Test Imageと手動Editは実際に画像利用枠を使う**。
- このWindows環境ではリポジトリ指定のpnpm 10を`corepack pnpm`で使用。サンドボックス内のPlaywrightブラウザ起動は`EPERM`になったため、ブラウザーテストだけ許可された環境で実行した。PlaywrightのwebServer終了待ちが止まる場合、起動済みテストサーバーで`PLAYWRIGHT_SKIP_WEBSERVER=true`として結果を確定できた。
