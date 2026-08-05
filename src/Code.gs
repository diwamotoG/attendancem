/**
 * 打刻ツール — サーバーロジック。
 *
 * クライアント（index.html）からは google.script.run 経由で
 * getStatus() と punch() のみを呼ぶ（ADR-0005）。
 *
 * 例外は投げず、必ず戻り値のフラグで結果を表現する（PLAN.md §4.1）。
 * withFailureHandler は通信断・スクリプト自体の異常だけに使う。
 */

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * Web App の GET。UI を返す（ADR-0005）。
 * index.html は Phase 2 で作成する。
 */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('打刻')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------

/**
 * 当日の打刻状況を返す。画面起動時と各打刻の直後に呼ばれる。
 *
 * この関数は例外を投げない。設定不足・カレンダー読み込み失敗は
 * error フィールドに詰めて返し、呼び出し側が常に Status を受け取れるようにする。
 *
 * @return {{date: string, start: ?string, end: ?string, guests: string[], error: ?string}}
 */
function getStatus() {
  const now = new Date();
  const status = {
    date: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd'),
    start: null,
    end: null,
    guests: [],
    error: null,
  };

  try {
    status.guests = getGuestEmails();
  } catch (e) {
    status.error = e.message;
  }

  try {
    const events = getTodayEvents(now);
    status.start = findPunchTime(events, PUNCH_TYPES.start.title);
    status.end = findPunchTime(events, PUNCH_TYPES.end.title);
  } catch (e) {
    status.error = status.error || 'カレンダーの読み込みに失敗しました: ' + e.message;
  }

  return status;
}

/**
 * 打刻する。カレンダーにイベントを作成し、招待先を追加する。
 *
 * 二重打刻は LockService による直列化と当日イベントの存在チェックの
 * 二段で防ぐ（ADR-0006）。存在チェックだけでは、ほぼ同時の2リクエストが
 * どちらも「未打刻」と判定して両方が作成に進む競合状態を防げない。
 *
 * @param {string} type 'start' または 'end'
 * @return {{ok: boolean, message?: string, error?: string, status: Object}}
 */
function punch(type) {
  const def = PUNCH_TYPES[type];
  if (!def) {
    return { ok: false, error: '不正な打刻種別です: ' + type, status: getStatus() };
  }

  let guests;
  try {
    guests = getGuestEmails();
  } catch (e) {
    return { ok: false, error: e.message, status: getStatus() };
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    return {
      ok: false,
      error: '他の処理を実行中です。少し待ってからもう一度お試しください。',
      status: getStatus(),
    };
  }

  try {
    const now = new Date();
    const existing = findPunchEvent(getTodayEvents(now), def.title);
    if (existing) {
      return {
        ok: false,
        error:
          '本日は既に「' + def.title + '」を打刻済みです（' +
          formatTime(existing.getStartTime()) + '）',
        status: getStatus(),
      };
    }

    getCalendar().createEvent(
      def.title,
      now,
      new Date(now.getTime() + EVENT_DURATION_MS),
      {
        guests: guests.join(','),
        sendInvites: SEND_INVITES,
      }
    );

    return {
      ok: true,
      message: '「' + def.title + '」を ' + formatTime(now) + ' で登録しました',
      status: getStatus(),
    };
  } catch (e) {
    return { ok: false, error: '打刻に失敗しました: ' + e.message, status: getStatus() };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** 記録先カレンダー。カレンダーが唯一の記録先である（ADR-0006, ADR-0010） */
function getCalendar() {
  return CalendarApp.getDefaultCalendar();
}

/**
 * 当日 0:00 〜 翌日 0:00 のイベントを返す。
 *
 * setHours はスクリプトのタイムゾーン（appsscript.json の timeZone）で
 * 解釈されるため、Asia/Tokyo 固定が日付境界の正しさを担保している（ADR-0007）。
 *
 * @param {Date} now
 * @return {CalendarEvent[]}
 */
function getTodayEvents(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return getCalendar().getEvents(start, end);
}

/**
 * イベント一覧から、指定タイトルの打刻イベントを1件返す。
 * 判定キーはタイトルの完全一致（ADR-0006）。
 *
 * @return {?CalendarEvent}
 */
function findPunchEvent(events, title) {
  for (let i = 0; i < events.length; i++) {
    if (events[i].getTitle() === title) {
      return events[i];
    }
  }
  return null;
}

/** 指定タイトルの打刻時刻を 'HH:mm' で返す。未打刻なら null */
function findPunchTime(events, title) {
  const ev = findPunchEvent(events, title);
  return ev ? formatTime(ev.getStartTime()) : null;
}

/** 時刻を JST の 'HH:mm' に整形する（ADR-0007） */
function formatTime(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'HH:mm');
}

// ---------------------------------------------------------------------------
// 動作確認用（GAS エディタから引数なしで実行する）
//
// GAS エディタの「実行」は関数に引数を渡せないため、punch() を直接は呼べない。
// Phase 1 の検証はこれらのラッパー経由で行う。
// ---------------------------------------------------------------------------

/** 設定と当日の打刻状況をログに出す */
function checkConfig() {
  const status = getStatus();
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/** 「開始」を打刻する（動作確認用） */
function testPunchStart() {
  const result = punch('start');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}

/** 「終了」を打刻する（動作確認用） */
function testPunchEnd() {
  const result = punch('end');
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
