/**
 * 設定値の定義と読み出し。
 *
 * 招待先メールアドレスはソースコードに置かず Script Properties から読む（ADR-0009）。
 * 挙動を切り替える定数はすべてこのファイルに集約し、Code.gs 側に散らさない。
 */

/** Script Properties のキー: 招待先メールアドレス（カンマ区切り） */
const PROP_GUEST_EMAILS = 'GUEST_EMAILS';

/**
 * 招待メールを送信するか（ADR-0004）。
 * 招待先の通知負担が問題になった場合は、ここを false にするだけで
 * メール送信を止められる。false でも招待先のカレンダーには予定が表示される。
 */
const SEND_INVITES = true;

/** 打刻イベントの長さ（ミリ秒）。長さ0は表示が不安定なため1分とする（ADR-0008） */
const EVENT_DURATION_MS = 60 * 1000;

/**
 * タイムゾーン（ADR-0007）。
 * appsscript.json の timeZone と必ず一致させること。
 * 時刻の文字列化では暗黙のロケールに頼らず、常にこの値を明示的に渡す。
 */
const TIME_ZONE = 'Asia/Tokyo';

/** ロック取得のタイムアウト（ミリ秒）。ADR-0006 */
const LOCK_TIMEOUT_MS = 10 * 1000;

/**
 * 打刻種別の定義（ADR-0003）。
 * key はクライアントから渡される識別子、title はカレンダー上のイベント名。
 * title は二重打刻の判定キーでもあるため、変更すると過去の打刻と一致しなくなる。
 */
const PUNCH_TYPES = {
  start: { key: 'start', title: '開始' },
  end: { key: 'end', title: '終了' },
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
