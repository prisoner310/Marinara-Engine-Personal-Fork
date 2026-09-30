# ChatGPT / Codex Image 私家改造メモ

この文書を、この私家改造の現在地を共有する正本とする。次の担当者は作業前にコードとGit状態を再確認し、実装・判断・テスト・次の課題が変われば作業後に更新する。ここには認証情報や実画像データを記載しない。

## 目的とGit構成

- 目的: Marinara Engineの通常のImage Generation Connectionで、既存の`codex login`によるChatGPT OAuthを使い、別のOpenAI Platform API Keyなしで画像生成・参照画像編集を利用する。
- 作業branch: `personal/codex-image`。`origin`は個人fork `prisoner310/Marinara-Engine-Personal-Fork`、`upstream`は公式 `Pasta-Devs/Marinara-Engine`。個人branchだけに通常pushし、公式側へのpush・PRはしていない。
- 履歴: Phase 1 `ec3ab4bcc`（OAuth画像接続）、Phase 2A `1a4b0cf74`（参照画像編集）、共有メモ追加 `31776fbd0`、Phase 2A.5 `ca99b312d`（透過・サイズ対応）、Phase 2A.6 `f30df8929`（サイズ診断）、Phase 2A.7 `a2b807657`（比率prompt補助）、Phase 2A.8 `61a59d5a26c4d5c05cfee09a227daa9a1823335e`（参照用途を決め打ちしない）、Phase 2A.9 `05d3fee8d23af6bf34e8a87c2c1eeefcdb820df6`（接続画面・文書・Prompt Reviewの説明）、説明修正 `0aa61ce78c2bbecd019e70644562a3cbe2179e18`。公式mainの `12a0acd5b` を基点とする個人branch上のコミット。
- **最後に確認した実装commit SHA:** `22701b4edada8be550c99e4894986b3039b0b291`（Phase 2A.10: Codexの自動参照画像収集を最大5枚へ統一）。共有メモ自体の最新commitは `git log -1` で確認する。

## 現在の判定: v1機能完成、参照上限は暫定5枚

**v1 implementation is functionally complete, but the production reference cap remains conservative pending follow-up.**（2026-09-30）。v1の定義は「Codex backendの現在提供する能力の範囲で、MEの標準画像生成フローへ安全に参加できること」。Phase 2A.10で自動参照収集とadapter上限を5枚に整合させ、関連mock回帰・通常チェックが成功した。Phase 2A.11の実アカウント診断でOAuth endpointは16枚まで受理したため、productionの5枚はbackendの確定上限ではなく安全側の暫定値。上限変更は次フェーズで扱う。各ME機能の実画像確認は下記ユーザー報告に基づき、今回の診断はendpointの参照枚数のみを確認した。

- feature-gap auditの確認範囲: Text-to-Image、Selfie、Avatar / Character Sheet、Illustrate、Game Scene / Storyboard、背景、Sprite、参照編集、negative prompt、native transparency、Settingsの寸法伝搬、比率補助、Prompt Review、Gallery保存、Test Connection / Test Image、共通queue / timeout / abort / fallback。
- **Phase 2A.10の上限:** Game / Storyboard、通常Illustrator、retry Illustrator、Conversation SelfieはCodex選択時に最大5枚。場所画像を使うGame / Storyboard / Illustratorでは、場所なしは人物最大5枚、場所ありは場所1枚＋人物最大4枚。収集とmergeに同じ合計上限を使う。Gallery Selfieの最大1枚、Avatar / Character Sheetの最大4枚は維持する。
- `codex-image-reference-limit.ts`を5枚の共通定義とし、既存の接続service解決を再利用する。Gameでは`codex_chatgpt`を明示backendとして判定し、`gpt-image-2`からOpenAIの16枚上限へ入る誤判定を防ぐ。他providerの上限、汎用Illustrator既定上限6枚、参照の意味・選択順は変更しない。直接渡された異なる参照が6枚以上の場合は、従来どおりadapterが送信前に明示エラーにする。
- GPT-Image 2固定、quality=`auto`、Seed / Steps / CFG / Sampler、LoRA / ComfyUI workflow、custom API parametersの非対応、厳密なpixel寸法の非保証はprovider固有差でありv1 blockerではない。mask、generation ID、multiple outputは現在のME共通`ImageGenRequest`にもないためv1対象外。

## Phase 2A.11: OAuth参照枚数の実アカウント診断

2026-09-30、HEAD `26c87d69c459ecf153ae49b2ebe85db7554032b7`のproductionコードを変更せず、一時スクリプトから既存OAuth helper・model constantを再利用して`POST /images/edits`へ直接送信した。ローカルで生成・デコード検査した**16個の異なる256×256 PNG**を使い、6枚の成功後にだけ16枚を送信。共通requestはmodel=`gpt-image-2`、background=`opaque`、quality=`auto`、size=`1024x1024`と中立的な短いprompt。画像リクエストは合計2回、自動retryなし。

| 参照枚数 | 結果 | HTTP | imagegen request ID |
| --- | --- | --- | --- |
| 6 | success: `data[0].b64_json`の画像を正常デコード | 200 | `b79a197f-7618-4590-99c9-27248ab08f50` |
| 16 | success: `data[0].b64_json`の画像を正常デコード | 200 | `70fd19bf-916e-4add-97bb-1c2e6aa7694a` |

- 両方のresponseはsize=`1254x1254`、background=`opaque`、quality=`medium`。デコードした画像の実寸も1254×1254。requestのqualityは`auto`であり、結果のmediumを固定設定として扱わない。
- **判定B: OAuth Images endpoint accepts at least 16 reference images.** 既存Codex source調査で確認されたbuilt-in image toolの5枚制限は、今回観測したOAuth endpointの上限ではなくclient/tool側の制限。16枚を超える真の最大枚数は未確認。一般GPT Image APIの資料とOAuth endpointの能力は別の根拠として扱う。
- 受理・画像返却の成功のみを確認した。全参照の内容が生成へ反映されたことや、他アカウント・将来のbackendで同じ上限になることまでは証明していない。
- **productionは5枚のまま:** 共通constant、adapter guard、自動収集、利用者向けdocs、CHANGELOG、UIは未変更。次フェーズで観測結果に基づく上限変更とmock回帰を検討する。
- 生成画像・参照画像・認証情報は保存していない。一時診断スクリプトは削除済み。今回は診断と共有メモのみのため、productionのbuild・回帰テストは再実行せず、PNG準備・デコード検査とGit差分検査を行った。

## 実装済みと実画像の確認状況

- **Phase 1:** `ChatGPT / Codex Image`をConnectionsから選択できる。API Key・Base URL入力不要、モデルは **GPT-Image 2 (`gpt-image-2`) 固定**。`generateImage()`から1枚のText-to-Imageを生成し、PNG base64を既存の画像結果・Gallery保存処理へ渡す。Test Connectionはローカルログインだけを検査し、画像利用枠を使わない。
- **Phase 2A:** 当初予定されていた`referenceImage` / `referenceImages`対応は**実装済み**。参照なしは`/images/generations`、参照ありはJSON形式の`/images/edits`。生base64と画像data URLを受け、順番を保って重複を除く。異なる参照画像が6枚以上なら送信前に明示的なエラーにする。
- **Phase 2A.5:** `transparentBackground=true`を`background="transparent"`へ、false/省略を`"opaque"`へ変換する。正の安全な整数のwidth/heightが両方あれば`"WIDTHxHEIGHT"`、なければ`"auto"`を生成と編集の両方へ送る。Spriteは**Codex接続の場合だけ**ネイティブ透過経路を選び、透過要求時のpromptからクロマキー指示を外す。通常のOpenAI Platform `gpt-image-2`の非対応判定と他providerのクロマキーfallbackは維持する。
- **ユーザーの実機確認済み:** Phase 1のTest ImageとGallery保存、参照画像1枚のImage Edit、バストアップ参照から全身Character Sheet、参照画像を使った表情差分Sprite。Phase 2A.5後は、`Transparent sprite background`をONにしてもpromptに`#00FF00`等が入らず、出力PNGに実際のalphaがあることを確認済み。**Codex接続のnative transparency経路は実機成功。**
- **Phase 2A.6の実機診断:** ME要求と送信`size`は一致したが、Codexのresponse宣言とPNG実寸はともに別サイズだった。参照付きCharacter Sheetは参照1206×1305・要求896×1152→出力1205×1305、Avatarは参照1037×1516・同要求→1038×1516（両方`quality=low`）。参照なし生成は要求896×1152→1145×1374、正方形要求1024×1024でも1145×1374（両方`quality=medium`）。editは参照canvasへ強く寄り、generationでもAPIの`size`は厳密なpixel数・比率を保証しない。Spriteの見た目が安定していても、強いlayout contractがあるためAPI `size`が効いた証拠にはしない。
- **prompt指定の実機診断:** 通常生成で896×1152をpromptへ書くと1106×1422（縦長に近い比率）。縦長参照1037×1516から正方形をprompt指定したeditは1254×1254、正方形参照1254×1254から892×1152の縦長をprompt指定したeditは1106×1422。promptのcanvas形状・比率指定には一定の効果があるが、pixel-perfectは保証されない。
- **Phase 2A.6の診断ログ:** generation/edit共通adapterがdebug levelで`[codex-image] endpoint=... requested=... sent=... response=... actual=... background=... quality=...`を1行記録する。`actual`はPNGのIHDR寸法。responseのmetadataが無くても成功し、寸法不一致もエラーにしない。token、account ID、prompt、画像base64はこの行に含めない。Phase 2A.7後も維持する。
- **Phase 2A.7:** Codex接続で有効なwidth/heightがある場合、orientation、最大公約数で約分した比率、nominal pixel sizeを画像promptへ追加する。Spriteの3生成経路は既存layout contractを優先し、補助文を追加しない。APIの`size`と診断ログを残す。厳密なpixel一致は保証しない。
- **Phase 2A.8:** Codex adapterのedit補助文からidentity・visual details・art style・requested editの用途指定を削除。参照画像のcanvas寸法・比率を継承しない案内と、Phase 2A.7のTarget canvas誘導だけに限定する。参照画像の用途はmain promptを権威とし、adapterにreference role分類は設けない。API `size`を維持し、**Codex adapter自体には**返却画像のresize・crop・paddingを追加しない。変更後にユーザーが実アカウントで参照画像ありの生成を行い、要求したaspect ratioに沿う出力を確認済み。
- **Phase 2A.9:** Connection画面と利用者向け文書で、要求width/heightは目標比率の案内に使うがCodexの返却pixel数は異なり得ると説明。参照画像比較表に最大5枚を追加。Prompt ReviewではCodexが足すcanvas文を編集不可の「Provider additions」に表示し、編集可能なmain prompt・別欄のnegative promptを維持する。previewと実送信は同じ小さなcanvas helperを使い、参照の有無も表示に反映する。Spriteは従来どおりこの補助文を除外。画像API・保存・透過・診断ログは変更しない。**ユーザー実機確認済み:** Provider additionsはCodex接続で表示され、他の画像providerでは表示されなかった。
- **Phase 2A.9説明修正:** 「Marinaraが常にnative pixel寸法を維持する」という断定をConnection画面・利用者向け文書から除去。Codex adapterは強制resizeしないが、既存MEのasset別保存経路には従来どおり後処理があり得る。画像生成やPrompt Reviewのロジックは変更していない。
- **Phase 2A.7実機確認済み:** 参照なしSelfieは要求896×1152→1106×1422（7:9）、1024×1024→1254×1254（1:1）。参照付きSelfieは正方形参照1254×1254から要求896×1152→1106×1422、縦長参照1037×1516から要求1024×1024→1254×1254。Character Sheetは正方形参照1254×1254から要求1280×720→1672×941（ほぼ16:9）。5件ともCodexのresponse宣言とPNG実寸は一致し、出力比率は要求に沿った。表情Spriteの一括生成も動作確認済み。**実用上の比率誘導は成功、pixel数の完全一致は未達・非目標。**
- 上記alphaは**現在のChatGPT / Codex経路で観測された事実**。GPT-Image 2そのものの公式alpha対応やCodex内部での実モデルへのルーティングは確定していない。自動テストでは実アカウントを使っていない。

## 現在の画像生成経路と設計判断

`Image Generation Connection (codex_chatgpt)` → `generateImage()` → `openai-chatgpt-image.ts` → 既存OAuth helper → `safeFetch` → ChatGPT Codex画像endpoint → `data[0].b64_json` → PNGの`ImageGenResult` → 既存の保存処理。Prompt Reviewと実送信のcanvas補助文は`codex-image-canvas.ts`を共用する。

- 認証は既存の`getOpenAIChatGPTAuth()`と`buildOpenAIChatGPTHeaders()`を再利用する。画像ごとにCodex CLIを起動しない。接続固有のURL・request・response変換は小さなadapterに閉じ込め、DB migrationと保存方式の変更を避ける。
- ChatGPT Codexのbase URLは `https://chatgpt.com/backend-api/codex`。`x-codex-image-turn-id`を付け、`safeFetch`のHTTPS制限を維持する。認証情報・参照画像base64をログやエラー文へ出さない。外部画像URLを取得しない。
- promptとnegative promptの組み立て、OAuth header、レスポンス解析、HTTPエラー変換はgeneration/editで共通。model=`gpt-image-2`、quality=`auto`、出力は1枚のPNG。MEのnegative promptは専用parameterではなく、`Do not include: ...`という自然文でmain promptへ追記する。
- **参照画像の用途はME本体の上流promptが担当する。** Selfieは`resolveIllustratorCharacterReferences()`からの`referenceLine`でcharacter likenessとvisual identityを指定する。spatial locationは`SPATIAL_LOCATION_REFERENCE_PROMPT_LINE`で場所として扱う。Illustrateは場所画像を先頭に人物画像を続け、人物と場所を別々に説明する。Game sceneもcharacter referenceとlocation referenceの説明を別々に構築する。Codex adapterはreference内容・用途を解釈せず、有効なwidth/heightがある場合に参照canvasの継承回避とTarget canvasのみを追加する。独自のreference role systemは作らない。
- MEのIllustrateは`imageSettings.illustration`（Gameでは`game`）とIllustratorの`aspectRatio`を`resolveIllustratorImageSize()`へ渡し、そのwidth/heightを`generateImage()`へ渡す。`portrait`は縦長、`landscape`は横長に並べ替え、`square`は短辺で正方形にする（Illustration既定896x1280なら順に896x1280、1280x896、896x896）。Selfieは`chatMeta.selfieResolution`が有効なら優先し、なければ`imageSettings.selfie.width/height`を`generateImage()`へ渡す。これらのGallery保存時のwidth/heightは要求値を再使用しており、**実PNGの寸法と異なる可能性がある**。Phase 2A.6では保存値の意味を変えない。
- **後処理の責務:** Codex adapterは返却画像を要求サイズに強制resize・crop・paddingしない。ただし、ME既存のasset別保存処理はそのまま適用される。例として`game-asset-generation.ts`の`gameBackgroundImage()`はSharpを利用できる場合、Game背景・Chat背景・Scene Illustrationを要求サイズに合わせてresizeし、比率によってcropする。Codex専用にこの処理を迂回しない。
- Spriteのprompt reviewと実生成は同じ接続種別付きの計画を使う。Codexのネイティブ透過要求には`#00FF00`等を入れず、他providerには従来のfallbackを残す。返った画像に既にalphaがある場合、既存の`alreadyTransparent`判定を背景除去エンジンの選択より先に行い、AIエンジンを明示した場合も画像を保護する。
- 既存のOpenAI Platform画像接続は別実装。GPT-Image 2.5はPlatform側にあっても、この接続では**Codex側が画像モデルの明示選択を提供するまで保留**し、モデルIDだけを推測して切り替えない。
- Codexの画像経路は内部仕様なので更新時に再確認する。2026-09-27に確認したCodex main: [built-in画像ツール](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs)、[Images request/response型](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/images.rs)、[画像API endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/images.rs)。built-inツールは`gpt-image-2`、quality=`auto`、size=`auto`をgeneration/edit双方で使い、通常引数にcustom sizeはない。一方、内部Images requestには文字列`size`、responseには任意の`size`・`background`・`quality`がある。[#28723](https://github.com/openai/codex/issues/28723)と[#19175](https://github.com/openai/codex/issues/19175)はサイズ制御の問題・要望を報告しているが、未解決issueは恒久仕様の根拠にしない。

## 制約と次の課題

- **本家取り込み向けの任意の改善:** 既存画像Connectionとの差分監査と、英語の利用者向け文書を他言語へ展開する作業。Phase 2A.9でConnection説明、文書、参照上限表、Prompt Reviewのread-only表示は対応済み。
- Avatar / Character SheetはreferenceImagesを渡せるが、Selfieの`referenceLine`相当の用途説明はこの経路では確認できなかった。必要なら**provider共通のME本体側課題**として検討し、Codex adapterだけで補わない。
- pixel-perfect sizeはCodex接続の完成条件に含めない。API `size`は維持し、Codex adapterでは返却画像を強制resize・crop・paddingしない。ME既存のasset別後処理は従来どおり適用される場合がある。比率が不安定なら実測とCodex側仕様を再確認する。`LOG_LEVEL=debug`の`[codex-image]`行は今後も確認に使えるが、debug出力全体には他経路のprompt等があり得るため、共有するのはこの1行だけにする。
- Character Avatar / Character Sheet生成modalは、画面を開いたまま外部の既定Image Generation Connectionを変更した場合、以前の選択・既定接続を保持することがある。`AvatarGenerationModal.tsx`の`connectionId` stateが既定接続より優先される既存挙動で、ユーザーの比較ではupstreamにも存在する。Codex固有の問題ではなく今回の対象外。**modal内の接続選択まで反映されないと確認されたわけではない。**
- Spriteの小さいキャンバス等、backendが受け付けるサイズ範囲は実機未確定。Codex Images request型の`String`は任意サイズの受理を保証しない。
- **canvas補助文は暫定workaround:** Codexが正式にcustom sizeを扱えるようになり、補助文なしの実画像で、参照なしのportrait / square / landscapeと、参照ありで参照canvasと異なる目標比率を確認できたら撤去を検討する。実送信とPrompt Reviewの補助文を同時に外し、API `size`の伝搬は別の責務として維持する。今回helper文面・Provider additionsは変更していない。
- **参照選択の将来候補:** `game.routes.ts`は`collectIllustrationCharacterAssets()`で登場人物を集め、`illustrator-references.ts`は設定されたcharacter sheet、avatar、spriteの順で候補を読む。場所画像は先頭に入る。Phase 2A.10はその順番を保ったままCodexの合計5枚を適用した。より高度な優先順位、reference role分類、generic provider capability frameworkは、明確な必要性またはupstream共通機構が出てから検討する。
- **その他のfuture work（v1 blockerではない）:** Provider additionsの表示位置をUXへ統合する場合も、編集可能なmain promptとは別データ・read-onlyを維持する。model selector / GPT-Image 2.5はCodex側の明示的なモデル選択待ち。quality selector、generation IDによる連続編集、mask、multiple output、Avatar / Character Sheetのprovider共通reference semantics改善も任意の拡張として扱う。
- 起動時更新で未追跡のadapterが消えた過去の報告がある。現在のadapterは個人branchに追跡・push済み。起動や更新後、branchと`git status`を確認する。

## 主なファイルとテスト

| ファイル | 役割 |
| --- | --- |
| `packages/server/src/services/llm/openai-chatgpt-auth.ts` | 既存のCodex ChatGPTログイン取得・更新 |
| `packages/server/src/services/image/openai-chatgpt-image.ts`・`codex-image-canvas.ts`・`image-prompt-review.ts` | generation/edit切替とHTTP、共通canvas補助文、Prompt Reviewへの同文提供、PNG結果・寸法診断 |
| `packages/server/src/services/image/codex-image-reference-limit.ts` | Codex最大5枚の共通定義と、既存の自動収集上限をCodex選択時だけ制限するhelper |
| `packages/server/src/services/game/game-asset-generation.ts`・`packages/server/src/routes/generate.routes.ts`・`packages/server/src/routes/generate/retry-agents-route.ts`・`packages/server/src/services/generation/conversation-selfie-command-runtime.ts` | Game / Storyboard、通常・retry Illustrator、Conversation Selfieの自動参照上限（場所込み） |
| `packages/server/src/services/image/image-generation.ts`・`packages/server/src/routes/sprites.routes.ts` | 共通`generateImage()`の振り分け、Sprite専用のcanvas補助文除外 |
| `packages/server/src/services/image/image-generation-settings.ts`・`packages/server/src/routes/generate.routes.ts`・`packages/server/src/services/generation/conversation-selfie-command-runtime.ts` | Illustrate/Selfieの要求サイズ決定・伝搬・Gallery保存（Phase 2A.6では未変更） |
| `packages/server/src/routes/sprites.routes.ts`・`packages/server/src/services/image/sprite-background.service.ts` | 接続別透過判定、Sprite prompt、alpha画像の背景除去skip |
| `packages/shared/src/constants/model-lists.ts` | Connectionのサービス名と固定モデル |
| `packages/server/src/routes/connections.routes.ts` | 接続テストとモデル一覧 |
| `packages/client/src/components/connections/ConnectionEditor.tsx`・`packages/client/src/components/ui/ImagePromptReviewModal.tsx`・`packages/client/src/components/ui/SpriteGenerationModal.tsx` | 接続画面のサイズ説明、Prompt ReviewのProvider additions表示、Spriteの透過警告 |
| `scripts/regressions/codex-chatgpt-image.regression.ts`・`scripts/regressions/open-issues.regression.ts` | mock HTTP、size metadata/IHDR、IllustrateのaspectRatioとSelfieサイズ伝搬の回帰 |
| `scripts/regressions/sprite-background.regression.ts`・`e2e/codex-chatgpt-image.e2e.ts`・`e2e/prompt-controls.e2e.ts` | 背景、接続画面、Prompt Review、Spriteプレビューの回帰 |
| `docs/media/image-providers.md` | 利用者向け手順 |

- Phase 2A.5時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像、Sprite背景（alpha PNGが強制AI背景除去を回避する検証を含む）、GPT-Image 2.5、画像custom parameters、画像サイズ制限の回帰は全件成功。Codex接続画面e2eはdesktop Chromium / mobile Chromium / mobile WebKitの3件成功。Spriteプレビューe2eも同3環境で3件成功。
- Phase 2A.6時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。既存の`GameNarration.tsx`警告1件）。Codex画像、画像サイズ制限、画像custom parameters、`open-issues`（Illustrate縦横正方形・Selfieサイズ伝搬を含む）、`prompt`（Selfie関連を含む）の回帰は各1/1成功。Codex mockは要求896x1280→送信896x1280、response宣言1024x1536、実PNGのIHDR読取、宣言なし、生成/edit共通、不一致時の成功、機密値のログ除外を確認。UI変更がないためPhase 2A.6でe2eは再実行していない。
- Phase 2A.7時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像、Sprite背景、画像サイズ制限、画像custom parameters、GPT-Image 2.5、`open-issues`、`prompt`のmock回帰は各1/1成功。896×1152→7:9 portrait、1280×720→16:9 landscape、1024×1024→1:1 square、参照付きeditのcanvas継承回避、invalid寸法で`size=auto`、negative prompt、Spriteの補助文除外を確認。UI変更がないためe2eは再実行していない。実画像は上記の5件とSprite一括生成で確認済み。
- Phase 2A.8時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像、`open-issues`、`prompt`、Sprite背景の回帰は各1/1成功。mockで参照editの用途中立なcanvas文、main promptの用途説明の保持、参照なしgeneration、7:9/16:9/1:1、negative prompt、invalid寸法の`size=auto`、Sprite補助文除外を確認。変更後にユーザーが参照画像ありの実画像で要求aspect ratioに沿う出力を確認済み。UI変更がないためこの段階ではe2eを再実行していない。
- Phase 2A.9時点の結果: `corepack pnpm check`成功（build・型検査・lint込み。未変更の`GameNarration.tsx`に既存lint警告1件）。Codex画像、Sprite背景、`open-issues`、`prompt`のmock回帰は各1/1成功。canvas補助文について、Prompt Reviewと実送信の一致、参照有無、無効寸法、Codex以外、Sprite除外を検査。関連Playwright 12件はdesktop Chromium / mobile Chromium / mobile WebKitで全件成功（`--workers=1`）。Connectionのsize説明、Avatarの参照有無によるpreview、read-only Provider additions、Spriteプレビューを確認。後日ユーザーが実機で、Provider additionsはCodex接続でのみ表示され他providerでは表示されないことを確認済み。Phase 2A.9作業中に実画像は新たに生成していない。
- Phase 2A.9説明修正後の結果: `corepack pnpm check`成功（既存の`GameNarration.tsx` lint警告1件）。Codex Connection画面のPlaywright 3件はdesktop Chromium / mobile Chromium / mobile WebKitで全件成功（`--workers=1`）。画像生成コードは変更せず、実画像生成も行っていない。
- **Phase 2A.10の結果:** `corepack pnpm check`成功（format・localization・lint・型検査・build。既存の`GameNarration.tsx` lint警告1件とbundle警告あり）、`corepack pnpm version:check`成功。`codex-chatgpt-image`、`open-issues`、`prompt`、`sprite-background`、`illustrator-reference-scope`、`spatial-context`、`spatial-location-reference`の回帰は各1/1、合計7/7成功。追加proofはCodex service/source判定、人物5枚・場所1枚＋人物4枚、normal / retry / Selfie / Gameの呼出し配線、他provider上限維持を確認し、既存の5枚受付・6枚拒否も成功。UI未変更のためPlaywrightは再実行せず、実画像生成も未実施。
- mockは合成画像・合成認証情報のみを使う。Test Connectionは画像を生成しないが、**Test Imageと手動Editは実際に画像利用枠を使う**。
- このWindows環境ではリポジトリ指定のpnpm 10を`corepack pnpm`で使用。サンドボックス内のPlaywrightブラウザ起動は`EPERM`になったため、ブラウザーテストだけ許可された環境で実行した。Phase 2A.9では6並列時にPlaywright自体の`test() to be called here`読み込みエラーが出たが、同じ12件を`--workers=1`で実行すると全件成功。PlaywrightのwebServer終了待ちが止まる場合、起動済みテストサーバーで`PLAYWRIGHT_SKIP_WEBSERVER=true`として結果を確定できた。
