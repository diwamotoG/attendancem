#!/usr/bin/env bash
#
# PLAN.md が ADR.md より後に更新されていたら、ADR.md の更新を促す。
# CLAUDE.md ルール2 の機械的な補助。
#
# 判定は mtime の比較で行う（このリポジトリは git 管理外のため差分の基準がない）。
# git 管理下に置く場合は `git status --porcelain` ベースの判定に置き換えるとより正確。
#
# 終了コード:
#   0 = 同期済み、または判定対象外
#   2 = PLAN.md が新しい → stderr が Claude に返り、対応を促す
#
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
plan="$root/PLAN.md"
adr="$root/ADR.md"

[ -f "$plan" ] && [ -f "$adr" ] || exit 0

# 既にこのフックで一度止めている場合は再度止めない（無限ループ防止）
input="$(cat || true)"
if printf '%s' "$input" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# macOS / BSD stat
plan_mtime="$(stat -f %m "$plan" 2>/dev/null)" || exit 0
adr_mtime="$(stat -f %m "$adr" 2>/dev/null)" || exit 0

if [ "$plan_mtime" -gt "$adr_mtime" ]; then
  cat >&2 <<'EOF'
[docs-sync] PLAN.md が ADR.md より後に更新されています。

CLAUDE.md ルール2 に従って、どちらかを行ってから応答を終えてください。

  1. 決定が変わった場合
     → ADR.md に新しいレコードを追記する、または
       既存レコードのステータスを「置換済み（ADR-00XX により置換）」に更新する

  2. 誤字修正・進捗更新など、決定が変わっていない場合
     → `touch ADR.md` を実行して同期済みとする

判定基準は「決定が変わったか」であり「ファイルが変わったか」ではありません。
EOF
  exit 2
fi

exit 0
