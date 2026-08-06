/**
 * 設定値の定義と読み出し。
 *
 * 招待先メールアドレスはソースコードに置かず Script Properties から読む（ADR-0009）。
 * 挙動を切り替える定数はすべてこのファイルに集約し、Code.gs 側に散らさない。
 */

/** Script Properties のキー: 招待先メールアドレス（カンマ区切り） */
const PROP_GUEST_EMAILS = 'GUEST_EMAILS';

/**
 * User Properties のキー: 打刻タイトルに載せる氏名（ADR-0024）。
 *
 * Script Properties ではなく User Properties に置く。
 * 実行主体ごとのバケットであるため、#9 が executeAs を USER_ACCESSING に
 * 切り替えた時点で自動的に利用者ごとに分かれる。
 * 現状の USER_DEPLOYING では実行主体が常にデプロイ者であり、バケットは1つしかない。
 *
 * GAS エディタの「プロジェクトの設定」からは見えない。
 * 確認は checkConfig()、設定は画面の入力欄か setupDisplayName() で行う。
 */
const PROP_DISPLAY_NAME = 'DISPLAY_NAME';

/**
 * 種別名と氏名の区切り文字（ADR-0023）。
 *
 * カレンダー上のタイトルは `{種別名}{TITLE_SEPARATOR}{氏名}` になる。
 * PUNCH_TYPES の title にこの文字を含めてはならない。
 * 分割位置が種別名の内部に来て種別判定が壊れる（PLAN.md §2.4）。
 */
const TITLE_SEPARATOR = '_';

/** 氏名の文字数上限。カレンダーのタイトルに載るため制限する（PLAN.md §4.1） */
const DISPLAY_NAME_MAX_LENGTH = 20;

/** 打刻イベントの長さ（ミリ秒）。長さ0は表示が不安定なため1分とする（ADR-0008） */
const EVENT_DURATION_MS = 60 * 1000;

/**
 * タイムゾーン（ADR-0007）。
 * appsscript.json の timeZone と必ず一致させること。
 * 時刻の文字列化では暗黙のロケールに頼らず、常にこの値を明示的に渡す。
 */
const TIME_ZONE = 'Asia/Tokyo';

/** ロック取得のタイムアウト（ミリ秒）。ADR-0018 で維持を決定 */
const LOCK_TIMEOUT_MS = 10 * 1000;

/**
 * 連打しきい値（ミリ秒）。
 * 直前の打刻からこの時間が経っていない打刻は、種別を問わず拒否する（PLAN.md F-8）。
 * 誤タップ対策の主軸のひとつ（ADR-0019）。
 */
const MIN_PUNCH_INTERVAL_MS = 60 * 1000;

/**
 * 状態導出の窓を何日前の 0:00 まで遡るか（PLAN.md §2.4）。
 * 日数であり時間幅ではない。0 にすると当日 0:00 起点となり、
 * 日跨ぎ勤務の退社が「勤務外からの退社」として拒否される（ADR-0018）。
 */
const STATE_LOOKBACK_DAYS = 1;

/** 勤務状態。打刻イベント列から毎回導出し、永続化しない（ADR-0018） */
const STATE_OFF_DUTY = 'offDuty';
const STATE_ON_DUTY = 'onDuty';
const STATE_ON_BREAK = 'onBreak';

/** 打刻が1件も無いときの状態 */
const INITIAL_STATE = STATE_OFF_DUTY;

/**
 * 打刻種別の定義（ADR-0017）。
 *
 * key はクライアントから punch() に渡す識別子、title は**種別名**である。
 * カレンダー上のイベント名は `{title}_{氏名}` であり、title そのものではない（ADR-0023）。
 * title は履歴表示と状態導出の両方で種別判定のキーになるため、
 * 変更すると過去の打刻がどちらにも現れなくなる。
 *
 * title に TITLE_SEPARATOR（'_'）を含めてはならない。
 *
 * from / to が PLAN.md §2.4 の遷移表そのものである。
 * 種別の追加時に定義と遷移の更新漏れが起きないよう、同じ場所に持たせている。
 * ここを変えたら testTransitions() の期待値（Code.gs）も必ず追随させること。
 *
 * sendInvites は招待メールの送信可否（ADR-0020）。
 * false でも招待者には追加され、招待先のカレンダーには予定が表示される。
 *
 * 宣言順は allowed の並び順になり、UI のボタン順の既定にもなる。
 */
const PUNCH_TYPES = {
  officeIn: {
    key: 'officeIn',
    title: 'リアル出社',
    sendInvites: true,
    from: [STATE_OFF_DUTY],
    to: STATE_ON_DUTY,
  },
  remoteIn: {
    key: 'remoteIn',
    title: 'リモート出社',
    sendInvites: true,
    from: [STATE_OFF_DUTY],
    to: STATE_ON_DUTY,
  },
  officeOut: {
    key: 'officeOut',
    title: 'リアル退社',
    sendInvites: true,
    from: [STATE_ON_DUTY],
    to: STATE_OFF_DUTY,
  },
  remoteOut: {
    key: 'remoteOut',
    title: 'リモート退社',
    sendInvites: true,
    from: [STATE_ON_DUTY],
    to: STATE_OFF_DUTY,
  },
  breakIn: {
    key: 'breakIn',
    title: '休憩開始',
    sendInvites: false,
    from: [STATE_ON_DUTY],
    to: STATE_ON_BREAK,
  },
  breakOut: {
    key: 'breakOut',
    title: '休憩終了',
    sendInvites: false,
    from: [STATE_ON_BREAK],
    to: STATE_ON_DUTY,
  },
};

/** 状態の呼称。エラーメッセージに使う */
const STATE_LABELS = {
  offDuty: '勤務外',
  onDuty: '勤務中',
  onBreak: '休憩中',
};

/**
 * 遷移を拒否したときの案内文。
 *
 * 遷移表の写しであるため、PUNCH_TYPES の from / to を変えたらここも直すこと。
 * 許可種別の一覧から機械的に生成すれば重複は消せるが、
 * 「休憩中は先に休憩終了を打つ」という順序の含意が失われるため手で持つ（PLAN.md §4.3）。
 */
const TRANSITION_HINTS = {
  offDuty: '先に「リアル出社」または「リモート出社」を打刻してください',
  onDuty: '打刻できるのは退社と「休憩開始」です',
  onBreak: '先に「休憩終了」を打刻してください',
};

/**
 * 招待先メールアドレスを返す。
 *
 * @return {string[]} 招待先メールアドレスの配列
 * @throws {Error} Script Properties に未設定の場合
 */
function getGuestEmails() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_GUEST_EMAILS);
  const emails = (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (emails.length === 0) {
    throw new Error(
      '招待先が未設定です。GAS エディタの「プロジェクトの設定 > スクリプト プロパティ」で ' +
        PROP_GUEST_EMAILS +
        ' にカンマ区切りのメールアドレスを設定してください。'
    );
  }
  return emails;
}

/**
 * 招待先を設定する。
 *
 * 通常は GAS エディタの「プロジェクトの設定 > スクリプト プロパティ」から
 * 手で設定する。この関数は clasp 経由などでプログラム的に設定したい場合に使う。
 * ADR-0009 に従い、実アドレスをこのファイルに書き込まないこと。
 *
 * @param {string} csv 例: 'a@gmail.com,b@gmail.com'
 */
function setupGuests(csv) {
  const emails = String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (emails.length === 0) {
    throw new Error('メールアドレスを1件以上、カンマ区切りで指定してください。');
  }
  PropertiesService.getScriptProperties().setProperty(PROP_GUEST_EMAILS, emails.join(','));
  return emails;
}

/**
 * 氏名の検証と正規化（PLAN.md §4.1）。
 *
 * 値はそのままカレンダーのタイトルに載るため、保存前に必ず通す。
 * PropertiesService に触れない純粋関数であり、testTitles() から直接検証できる。
 *
 * TITLE_SEPARATOR を含む氏名は許容する。種別判定は最初の区切りだけを見るため、
 * 氏名側の '_' は後半に残るだけで影響しない（ADR-0023）。
 *
 * @param {string} raw 入力値
 * @return {{ok: boolean, name?: string, error?: string}}
 */
function validateDisplayName(raw) {
  const name = String(raw == null ? '' : raw).trim();

  if (name.length === 0) {
    return { ok: false, error: '氏名を入力してください' };
  }
  // 制御文字。タイトルに改行が入るとカレンダー上の表示が壊れる
  if (/[\u0000-\u001F\u007F]/.test(name)) {
    return { ok: false, error: '氏名に改行やタブは使えません' };
  }
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: '氏名は' + DISPLAY_NAME_MAX_LENGTH + '文字以内で入力してください',
    };
  }
  return { ok: true, name: name };
}

/**
 * 氏名を返す。未設定なら null。
 *
 * getGuestEmails() と異なり例外を投げない。
 * getStatus() が displayName に null を詰めて返せるようにするため。
 *
 * @return {?string}
 */
function getDisplayName() {
  const raw = PropertiesService.getUserProperties().getProperty(PROP_DISPLAY_NAME);
  const name = String(raw == null ? '' : raw).trim();
  return name.length > 0 ? name : null;
}

/**
 * 氏名を保存する。
 *
 * 通常は画面の入力欄から setDisplayName()（Code.gs）経由で呼ばれる。
 * この関数は clasp 経由などでプログラム的に設定したい場合に使う。
 * User Properties には GAS エディタの一覧 UI が無いため、
 * 「プロジェクトの設定」から手で設定することはできない（ADR-0024）。
 *
 * @param {string} name 例: '山田太郎'
 * @return {string} 保存した氏名
 * @throws {Error} 検証に失敗した場合
 */
function setupDisplayName(name) {
  const result = validateDisplayName(name);
  if (!result.ok) {
    throw new Error(result.error);
  }
  PropertiesService.getUserProperties().setProperty(PROP_DISPLAY_NAME, result.name);
  return result.name;
}
