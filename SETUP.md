# SETUP.md — AI Agent 向けセットアップ手順書

**この文書の読者は AI Agent である。** attendancem を新しい Google アカウントで
セットアップするとき、Agent はこの文書を上から順に実行する。

人間向けの説明は [README.md](./README.md) にある。仕様は [PLAN.md](./PLAN.md)、
設計判断の理由は [ADR.md](./ADR.md) を参照する。

---

## Agent への基本指示

作業を始める前に、以下を必ず守ること。

| 禁止事項 | 理由 |
|---------|------|
| `npm install -g` を使う | グローバル環境を汚す。clasp はプロジェクトローカルに導入する（[ADR-0012](./ADR.md#adr-0012)） |
| 招待先の実メールアドレスをソースコードに書く | Script Properties から読む設計（[ADR-0009](./ADR.md#adr-0009)）。`Config.gs` に実値を書き込まない |
| 検証ゲートを飛ばして `push` する | `src/appsscript.json` が壊れたまま GAS に反映される。**ステップ4の事故が起きる** |
| ユーザーの代わりに OAuth 同意画面を操作する | 認証は人間本人が行う。Agent はコマンドを提示して待つ |
| `git commit` をユーザーの指示なく行う | 明示的な依頼があったときだけコミットする |

**🔴 STOP マークの付いたステップは人間にしか実行できない。**
Agent はそこで作業を止め、ユーザーに依頼して結果を待つこと。勝手に次へ進まない。

各ステップ末尾の**検証**は必須である。期待結果と一致しない場合、次のステップへ進まず
ユーザーに状況を報告すること。

---

## ステップ 0 — 前提の確認

リポジトリを取得する（未取得の場合）。

```bash
git clone git@github.com:diwamotoG/attendancem.git
cd attendancem
```

```bash
node -v    # v18 以上であること
npm -v
```

以降はリポジトリのルート（`PLAN.md` と `src/` がある階層）で作業する。

**このリポジトリを fork / clone した場合、GAS プロジェクトは各自で新規作成する。**
`.clasp.json`（scriptId）と `.clasprc.json`（認証情報）は `.gitignore` 済みで
リポジトリに含まれないため、ステップ3・4を必ず実施すること。

**検証**: `src/` に `appsscript.json` / `Code.gs` / `Config.gs` / `index.html` の4ファイルがあること。

---

## ステップ 1 — 🔴 STOP: Apps Script API を有効化する（人間）

ユーザーに以下を依頼する。

> https://script.google.com/home/usersettings を開き、
> 「Google Apps Script API」を **ON** にしてください。

**これを飛ばすとステップ4が必ず失敗する。** OFF のまま `create` すると
`User has not enabled the Apps Script API.` が返る。ON にした直後は反映に
数分かかることがあり、その場合は少し待って再実行する。

---

## ステップ 2 — clasp をプロジェクトローカルに導入する

```bash
npm install
```

**検証**: グローバル環境が汚れていないことを確認する。

```bash
npm ls -g --depth=0        # clasp が「無い」こと。npm と corepack だけのはず
ls node_modules/.bin/clasp # 存在すること
```

以降、clasp は必ず npm scripts 経由で呼ぶ。素の `npx clasp` は `--auth` が付かず
別の認証状態（ホーム直下）を見に行くため使わない。

---

## ステップ 3 — 🔴 STOP: clasp にログインする（人間）

ユーザーに以下の実行を依頼する。ブラウザで OAuth 同意画面が開く。

```bash
npm run login
```

認証情報はホーム直下ではなくリポジトリ内の `.clasprc.json` に保存される
（`.gitignore` 済み）。

**検証**:

```bash
npm run whoami   # "You are logged in as <メールアドレス>." が返ること
ls ~/.clasprc.json 2>&1   # "No such file" であること（ホームが汚れていない証明）
```

ここで表示されたアカウントの**カレンダーに打刻イベントが作られる**。
意図したアカウントかどうかユーザーに確認すること。違う場合は `npm run logout` してやり直す。

---

## ステップ 4 — GAS プロジェクトを作成する（⚠️ 最重要）

### なぜ順序を工夫するのか

`clasp create-script` は、新規プロジェクトのひな形マニフェストを **`--rootDir` に指定した
ディレクトリへ clone する**。素直に `--rootDir ./src` を指定すると、
リポジトリの `src/appsscript.json` が GAS 既定値で**上書きされる**。

```
上書き後:  "timeZone": "America/New_York"   ← ADR-0007（Asia/Tokyo 固定）が消える
           webapp ブロックなし               ← ADR-0002（自分のみアクセス）が消える
           oauthScopes なし                  ← ADR-0014（calendar のみ）が消える
```

この状態で `push` すると、**打刻時刻が9時間ずれ、かつ URL を知る他人がアクセスできる**
Web App が出来上がる。2026-08-05 のセットアップで実際に発生した事故である
（[ADR-0014](./ADR.md#adr-0014)）。

**対策は修復ではなく回避である。** clone 先を捨てディレクトリに向け、
`src/` に一切触れさせない。

### 4-1. 保険をかける

git 管理下なら、作業ツリーがクリーンな状態から始める。

```bash
git status --short   # 出力が空であること。差分があればユーザーに確認する
```

git 管理下でない場合は `src/appsscript.json` を退避しておく。

```bash
cp src/appsscript.json /tmp/appsscript.json.bak
```

### 4-2. clone 先を捨てディレクトリに向けて作成する

```bash
npm run create
```

このスクリプトは `--rootDir ./.gas-init` を指定してある（[ADR-0015](./ADR.md#adr-0015)）。
`Created new script: https://script.google.com/d/<scriptId>/edit` が返り、
ひな形マニフェストは `.gas-init/appsscript.json` に落ちるため **`src/` は無傷のまま**。

> `--rootDir ./src` に書き換えてはならない。それが上書き事故そのものである。

### 4-3. rootDir を `src` に戻す

`create-script` が生成した `.clasp.json` の `"rootDir"` を `.gas-init` から `src` に書き換える。

```json
{
  "scriptId": "<生成された scriptId>",
  "rootDir": "src",
  ...
}
```

捨てディレクトリを削除する。

```bash
rm -rf .gas-init
```

### 4-4. 🚦 検証ゲート（必須）

**push の前に必ず実行する。** ここを飛ばしてはならない。

```bash
cat src/appsscript.json
```

以下の3点すべてを満たすこと。1つでも欠けていたら次へ進まない。

- [ ] `"timeZone": "Asia/Tokyo"`
- [ ] `"webapp": { "executeAs": "USER_DEPLOYING", "access": "MYSELF" }`
- [ ] `"oauthScopes": ["https://www.googleapis.com/auth/calendar"]`

満たさない場合（＝上書きが起きた場合）は復元する。

```bash
git checkout HEAD -- src/appsscript.json     # git 管理下の場合
cp /tmp/appsscript.json.bak src/appsscript.json   # 退避していた場合
```

`.clasp.json` の `"rootDir"` が `"src"` であることも併せて確認する。

---

## ステップ 5 — GAS に反映する

```bash
npm run push -- --force
```

`--force` はリモートのマニフェストを上書きするために必要。これが無いと
`appsscript.json` の変更が反映されないことがある。

**検証**: 4ファイルすべてが push されたこと。

```
Pushed 4 files.
└─ src/appsscript.json
└─ src/Code.gs
└─ src/Config.gs
└─ src/index.html
```

`node_modules/` や `package.json` が一覧に出ていたら `.clasp.json` の `rootDir` が
間違っている。`npm run status` で push 対象を確認し直すこと。

**GAS 側の実物を検証する**（マニフェストが正しく届いたかの最終確認）。
リポジトリを汚さないよう、一時ディレクトリへ pull して突き合わせる。

```bash
TMP=$(mktemp -d)
SCRIPT_ID=$(node -p "require('./.clasp.json').scriptId")
cat > "$TMP/verify.clasp.json" <<EOF
{ "scriptId": "$SCRIPT_ID", "rootDir": "$TMP/remote",
  "scriptExtensions": [".js", ".gs"], "htmlExtensions": [".html"],
  "jsonExtensions": [".json"], "filePushOrder": [], "skipSubdirectories": false }
EOF
npx clasp -A ./.clasprc.json -P "$TMP/verify.clasp.json" pull >/dev/null
diff src/appsscript.json "$TMP/remote/appsscript.json" && echo "✅ GAS 側と一致"
rm -rf "$TMP"
```

`✅ GAS 側と一致` が出ればステップ4〜5は完了。

---

## ステップ 6 — 🔴 STOP: 招待先を設定する（人間）

ユーザーに以下を依頼する。

> GAS エディタを開き（`npm run open`）、
> **⚙ プロジェクトの設定 > スクリプト プロパティ > スクリプト プロパティを追加** で
> 次を登録して保存してください。
>
> | プロパティ | 値 |
> |-----------|-----|
> | `GUEST_EMAILS` | `1人目@gmail.com,2人目@gmail.com` |
>
> - キーは `GUEST_EMAILS` 完全一致
> - **カンマ区切りで1行に2件**。プロパティを2つに分けない
> - 前後の空白は自動で除去される

**Agent は実メールアドレスを受け取る必要がない。** ユーザーが直接 GAS の画面に入力する。
`Config.gs` にアドレスを書き込んではならない（[ADR-0009](./ADR.md#adr-0009)）。

`Config.gs` の `setupGuests(csv)` はプログラム設定用のヘルパーだが、
**GAS エディタの「実行」は引数を渡せないため、この手順では使えない。**

---

## ステップ 7 — 🔴 STOP: 動作確認（人間・GAS エディタ）

GAS エディタで関数を順に実行するようユーザーに依頼する。
初回実行時に OAuth の承認画面が出る。

### 7-1. `checkConfig()`

「このアプリは Google で確認されていません」という警告が出る。これは審査を受けていない
個人スクリプトでは正常。**警告に表示される「デベロッパー」が自分自身のアドレスであること**を
確認してから「詳細」→「（安全ではないページ）に移動」→「許可」。

権限確認画面で要求されるのは**カレンダーのみ**であること。
Gmail・ドライブなどが並んでいたらマニフェストの宣言と食い違うため中断して報告する。

期待するログ:

```json
{ "date": "YYYY-MM-DD", "punches": [], "state": "offDuty",
  "allowed": ["officeIn", "remoteIn"],
  "guests": ["1人目@gmail.com", "2人目@gmail.com"], "error": null }
```

`error` が `null` で `guests` が2件揃うこと。
当日の打刻がまだ無ければ `punches` は空配列、`state` は `offDuty` になる。

### 7-2. `testTransitions()`

勤務状態の遷移表を検証する自動テスト（[ADR-0021](./ADR.md#adr-0021)）。
**カレンダーにも招待メールにも一切触れない**ため、打刻を試す前に通しておく。

期待するログ:

```
testTransitions: 31/31 件合格、失敗 0 件
```

`失敗 0 件` でなければ次へ進まない。`NG` 行に期待値と実際値が出るので、
PLAN.md §2.4 の遷移表と `Config.gs` の `PUNCH_TYPES`（`from` / `to`）の
どちらが食い違っているかを報告すること。

### 7-3. 打刻のラッパー関数

> ⚠️ **実行するとカレンダーに予定が作られ、出社・退社は招待先2名に実際にメールが届く。**
> `GUEST_EMAILS` にプレースホルダ（`a@gmail.com` など実在する他人のアドレス）が
> 入っていないか、実行前に必ず確認すること。

**この順に実行する。順序に意味がある。**

| # | 関数 | 期待結果 |
|---|------|---------|
| 1 | `testPunchOfficeIn()` | `リアル出社` が現在時刻で作成、2名に招待メール |
| 2 | `testPunchBreakIn()` | `休憩開始` が作成。**招待メールは届かない** |
| 3 | `testPunchBreakOut()` | `休憩終了` が作成。招待メールは届かない |
| 4 | `testPunchOfficeOut()` | `リアル退社` が作成、2名に招待メール |

`testPunchRemoteIn()` / `testPunchRemoteOut()` も同じ要領で確認できる
（それぞれ `リモート出社` / `リモート退社` が作成され、2名に招待メールが届く）。
引数付きの `punch('officeIn')` はエディタから直接実行できないため、
ラッパー関数を使う（PLAN.md §5 Phase 1）。

**2つの制約に注意すること。** どちらも仕様であり、故障ではない。

- **順序**: 勤務外の状態で `testPunchOfficeOut()` を実行しても、
  状態遷移チェックに弾かれて `ok: false` が返りイベントは作成されない
  （[ADR-0018](./ADR.md#adr-0018)）。上の表の順に実行する
- **間隔**: 各実行の間を**1分以上あける**。直前の打刻から1分未満は種別を問わず
  拒否される（[ADR-0019](./ADR.md#adr-0019)）。連続実行すると
  `直前の打刻から1分経過していません` が返る

**検証**:

- 作成された予定の時刻が JST でずれていないこと（ADR-0007）。
  ずれている場合は `src/appsscript.json` の `timeZone` を疑う
- **2の直後に招待先の受信箱を確認し、休憩のメールが届いていないこと。**
  `sendInvites: false` はカレンダーへの表示を残すため、
  カレンダー側だけを見ても抑止できているか判断できない（[ADR-0020](./ADR.md#adr-0020)）

確認で作成した予定は、カレンダーから削除しておくようユーザーに伝える。

---

## ステップ 8 — 🔴 STOP: Web App をデプロイする（人間）

> GAS エディタの **デプロイ > 新しいデプロイ** → 種類「ウェブアプリ」を選び、
> 以下を確認してデプロイしてください。
>
> - **次のユーザーとして実行**: 自分
> - **アクセスできるユーザー**: 自分のみ
>
> 発行された Web App URL を控えてください。

この2設定は [ADR-0002](./ADR.md#adr-0002) の前提であり、変えると URL を知る他人が
打刻できるようになる。`appsscript.json` に同じ設定が入っているため通常は初期値のままでよいが、
**画面上でも必ず目視確認する。**

---

## ステップ 9 — 🔴 STOP: ホーム画面に追加（人間・iPhone）

> Safari で Web App URL を開き、共有ボタン →「ホーム画面に追加」。

これでホーム画面から2タップで打刻できる（PLAN.md 非機能要件 N-2）。

**セットアップはここまで。** 以降のコード変更を本番へ反映する手順は
[DEPLOY.md](./DEPLOY.md) を参照する。`npm run push` は本番反映ではない点に注意。

---

## 完了条件

- [ ] `npm ls -g --depth=0` に clasp が無い（グローバル環境が汚れていない）
- [ ] `~/.clasprc.json` が存在しない（認証情報がリポジトリ内に閉じている）
- [ ] `src/appsscript.json` が `Asia/Tokyo` / `webapp` / `oauthScopes` の3点を保持
- [ ] GAS 側のマニフェストがローカルと一致
- [ ] `checkConfig()` が `error: null`、`guests` 2件
- [ ] `testTransitions()` が `失敗 0 件`
- [ ] `testPunchOfficeIn()` / `testPunchOfficeOut()` でカレンダーに予定と招待メール
- [ ] `testPunchBreakIn()` / `testPunchBreakOut()` でカレンダーに予定。**招待メールは届かない**
- [ ] Web App が「自分として実行 / 自分のみアクセス」でデプロイ済み
- [ ] ホーム画面から2タップで打刻できる

---

## トラブルシュート（セットアップ時）

| 症状 | 原因と対処 |
|------|-----------|
| `User has not enabled the Apps Script API.` | ステップ1を実施していない。ON にして数分待つ |
| `create-script` が `.clasp.json already exists` で失敗 | 既にプロジェクトが紐づいている。作り直すなら `.clasp.json` を削除してから再実行する |
| push 対象に `node_modules` が含まれる | `.clasp.json` の `rootDir` が `src` になっていない |
| push したのにマニフェストが変わらない | `--force` を付けていない。`npm run push -- --force` |
| `Not logged in.` が出る | 素の `npx clasp` を叩いている。npm scripts 経由で実行する |
| 打刻時刻が9時間ずれる | ステップ4の上書きが起きている。検証ゲートに戻る |

---

## 撤去する

```bash
npm run logout
rm -rf node_modules package-lock.json .clasprc.json .clasp.json .gas-init
```

グローバル環境には何も残らない。

---

## このリポジトリを変更する場合

[CLAUDE.md](./CLAUDE.md) のドキュメント同期ルールに従うこと。

1. 実装が PLAN.md と食い違うなら、実装より先に PLAN.md を直す
2. PLAN.md の変更で「決定」が変わったなら、同じ作業の中で ADR.md も更新する
3. ADR.md の過去レコードは書き換えない（追記のみ。ステータス行の更新だけが例外）

`.claude/hooks/check-docs-sync.sh`（Stop hook）が PLAN.md と ADR.md の
更新順を機械的に検知する。
