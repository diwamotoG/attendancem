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
 * 当日の打刻履歴と現在の勤務状態を返す。画面起動時と各打刻の直後に呼ばれる。
 *
 * この関数は例外を投げない。設定不足・カレンダー読み込み失敗は
 * error フィールドに詰めて返し、呼び出し側が常に Status を受け取れるようにする。
 *
 * punches は当日分、state / allowed は前日 0:00 からの列で導出する（PLAN.md §2.4）。
 * 窓が異なるため、日跨ぎ勤務では「履歴が空なのに state が onDuty」が正常に起こりうる。
 *
 * @return {{date: string, punches: Object[], state: string, allowed: string[],
 *           guests: string[], error: ?string}}
 */
function getStatus() {
  const now = new Date();
  const status = {
    date: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd'),
    punches: [],
    state: INITIAL_STATE,
    allowed: getAllowedTypes(INITIAL_STATE),
    guests: [],
    error: null,
  };

  try {
    status.guests = getGuestEmails();
  } catch (e) {
    status.error = e.message;
  }

  try {
    const punches = collectPunches(now);
    status.punches = punches.today.map(function (p) {
      return { type: p.type, title: p.title, time: p.time };
    });
    status.state = deriveState(toTypes(punches.upToNow));
    status.allowed = getAllowedTypes(status.state);
  } catch (e) {
    status.error = status.error || 'カレンダーの読み込みに失敗しました: ' + e.message;
  }

  return status;
}

/**
 * 打刻する。カレンダーにイベントを作成し、招待先を追加する。
 *
 * 同一種別の重複は禁止しない。同日に何ペアあってもよい（ADR-0018）。
 * 代わりに、連打しきい値（F-8）と状態遷移チェック（F-7）で不正な打刻を弾く。
 * LockService は維持する。ほぼ同時の2リクエストが両方とも同じ状態を読み、
 * 両方が作成に進む競合を防ぐのは排他だけである（ADR-0018 の決定2）。
 *
 * 判定順は PLAN.md §4.1 のとおり
 * 種別 → 招待先 → ロック → 連打しきい値 → 状態遷移 とする。
 *
 * @param {string} type PUNCH_TYPES のキー（PLAN.md §2.4 の6種別）
 * @return {{ok: boolean, message?: string, error?: string, status: Object}}
 */
function punch(type) {
  const def = getPunchType(type);
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
    const punches = collectPunches(now);
    const previous = punches.upToNow.length
      ? punches.upToNow[punches.upToNow.length - 1]
      : null;

    // 連打しきい値。種別を問わない無条件のゲート（F-8 / ADR-0019）
    if (previous && now.getTime() - previous.at.getTime() < MIN_PUNCH_INTERVAL_MS) {
      return {
        ok: false,
        error:
          '直前の打刻から' + formatInterval(MIN_PUNCH_INTERVAL_MS) + '経過していません（' +
          previous.time + ' に「' + previous.title + '」）',
        status: getStatus(),
      };
    }

    // 状態遷移チェック（F-7 / ADR-0018）
    const state = deriveState(toTypes(punches.upToNow));
    if (def.from.indexOf(state) === -1) {
      return {
        ok: false,
        error: STATE_LABELS[state] + 'です。' + TRANSITION_HINTS[state],
        status: getStatus(),
      };
    }

    getCalendar().createEvent(
      def.title,
      now,
      new Date(now.getTime() + EVENT_DURATION_MS),
      {
        guests: guests.join(','),
        sendInvites: def.sendInvites,
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
// 状態遷移（純粋関数）
//
// このセクションの関数は CalendarApp / PropertiesService / new Date() に触れない。
// これが testTransitions() による自動検証が成立する条件であり、
// ADR-0021 が punch() に課した制約でもある。遷移の判定をここから
// punch() の中に移すと、テストは通るのに本番が壊れる状態になりうる。
// ---------------------------------------------------------------------------

/**
 * 状態から遷移できる type の配列を返す（PLAN.md §2.4 の遷移表）。
 * 並び順は PUNCH_TYPES の宣言順であり、UI のボタン順の既定にもなる。
 *
 * @param {string} state STATE_OFF_DUTY / STATE_ON_DUTY / STATE_ON_BREAK
 * @return {string[]}
 */
function getAllowedTypes(state) {
  const allowed = [];
  for (const key in PUNCH_TYPES) {
    if (PUNCH_TYPES[key].from.indexOf(state) !== -1) {
      allowed.push(key);
    }
  }
  return allowed;
}

/**
 * 打刻 type の配列（時刻の昇順）から到達状態を導出する。
 *
 * 遷移表で許可されない打刻、および未知の type は1件無視して状態を維持する。
 * カレンダーを手で編集した結果、辻褄の合わない列が入力になりうるためであり、
 * その1件で導出を打ち切ったり初期状態に戻したりはしない（PLAN.md §2.4）。
 *
 * @param {string[]} types
 * @return {string} 到達状態
 */
function deriveState(types) {
  let state = INITIAL_STATE;
  for (let i = 0; i < types.length; i++) {
    const def = getPunchType(types[i]);
    if (def && def.from.indexOf(state) !== -1) {
      state = def.to;
    }
  }
  return state;
}

/**
 * 打刻種別の定義を返す。未定義なら null。
 * hasOwnProperty で引くのは、'constructor' などの継承プロパティを
 * 種別として拾わないため。
 *
 * @return {?Object}
 */
function getPunchType(type) {
  return Object.prototype.hasOwnProperty.call(PUNCH_TYPES, type) ? PUNCH_TYPES[type] : null;
}

// ---------------------------------------------------------------------------
// 内部ヘルパー
// ---------------------------------------------------------------------------

/** 記録先カレンダー。カレンダーが唯一の記録先である（ADR-0010, ADR-0018） */
function getCalendar() {
  return CalendarApp.getDefaultCalendar();
}

/** 1日のミリ秒数。Asia/Tokyo は夏時間を持たないため、日境界の加減算に使える */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * その日の 0:00 を返す。
 *
 * setHours はスクリプトのタイムゾーン（appsscript.json の timeZone）で
 * 解釈されるため、Asia/Tokyo 固定が日付境界の正しさを担保している（ADR-0007）。
 *
 * @param {Date} date
 * @return {Date}
 */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 打刻イベントを収集する。カレンダーの読み込みはこの1回にまとめる。
 *
 * 窓は STATE_LOOKBACK_DAYS 日前の 0:00 から当日 24:00 まで。
 * 起点を「現在から N 時間前」ではなくカレンダー日付の境界に置くのは、
 * 呼び出し時刻によって窓が動くと同じ打刻列でも結果が変わるためである（PLAN.md §2.4）。
 *
 *  - today   : 履歴表示用。当日 0:00 以降の打刻
 *  - upToNow : 状態導出用。窓の起点から現在までの打刻
 *
 * @param {Date} now
 * @return {{today: Object[], upToNow: Object[]}} 各要素は {type, title, time, at}
 */
function collectPunches(now) {
  const todayStart = startOfDay(now);
  const windowStart = new Date(todayStart.getTime() - STATE_LOOKBACK_DAYS * DAY_MS);
  const windowEnd = new Date(todayStart.getTime() + DAY_MS);

  const events = getCalendar().getEvents(windowStart, windowEnd);
  const punches = [];
  for (let i = 0; i < events.length; i++) {
    const title = events[i].getTitle();
    const type = typeOfTitle(title);
    if (!type) {
      continue; // 打刻以外の予定は履歴にも状態導出にも影響しない（T-20）
    }
    const at = events[i].getStartTime();
    // getEvents は窓に重なる予定を返すため、窓より前に始まる長い予定を落とす
    if (at.getTime() < windowStart.getTime()) {
      continue;
    }
    punches.push({ type: type, title: title, at: at, time: formatTime(at) });
  }

  punches.sort(function (a, b) {
    return a.at.getTime() - b.at.getTime();
  });

  return {
    today: punches.filter(function (p) {
      return p.at.getTime() >= todayStart.getTime();
    }),
    upToNow: punches.filter(function (p) {
      return p.at.getTime() <= now.getTime();
    }),
  };
}

/** collectPunches の要素配列から type だけを取り出す */
function toTypes(punches) {
  return punches.map(function (p) {
    return p.type;
  });
}

/**
 * イベントタイトルから打刻種別を引く。判定キーはタイトルの完全一致。
 * 改訂前の「開始」「終了」はどの種別にも一致しない（ADR-0017）。
 *
 * @return {?string} PUNCH_TYPES のキー。打刻イベントでなければ null
 */
function typeOfTitle(title) {
  for (const key in PUNCH_TYPES) {
    if (PUNCH_TYPES[key].title === title) {
      return key;
    }
  }
  return null;
}

/** 時刻を JST の 'HH:mm' に整形する（ADR-0007） */
function formatTime(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'HH:mm');
}

/** しきい値をエラーメッセージ用に整形する。60000 → '1分' */
function formatInterval(ms) {
  return ms % 60000 === 0 ? ms / 60000 + '分' : Math.round(ms / 1000) + '秒';
}

// ---------------------------------------------------------------------------
// 動作確認用（GAS エディタから引数なしで実行する）
//
// GAS エディタの「実行」は関数に引数を渡せないため、punch() を直接は呼べない。
// 検証はこれらのラッパー経由で行う。
// ---------------------------------------------------------------------------

/** 設定と当日の打刻状況をログに出す */
function checkConfig() {
  const status = getStatus();
  Logger.log(JSON.stringify(status, null, 2));
  return status;
}

/**
 * 遷移表の自動テスト（PLAN.md §6.1 / ADR-0021）。
 *
 * カレンダーにも UI にも触れず、純粋関数だけを検証する。
 * 期待値は PLAN.md §2.4 の遷移表を手で写したものである。
 * PUNCH_TYPES から導出すると実装が実装を検証することになり、テストが自明になる。
 *
 * @return {{total: number, failed: number, failures: string[]}}
 */
function testTransitions() {
  const failures = [];
  let total = 0;

  function check(label, actual, expected) {
    total++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) {
      failures.push(label + ' — 期待: ' + e + ' / 実際: ' + a);
    }
  }

  // --- PLAN.md §2.4 の遷移表の写し ---
  const ALLOWED_BY_STATE = {
    offDuty: ['officeIn', 'remoteIn'],
    onDuty: ['officeOut', 'remoteOut', 'breakIn'],
    onBreak: ['breakOut'],
  };
  const ALL_STATES = ['offDuty', 'onDuty', 'onBreak'];
  const ALL_TYPES = ['officeIn', 'remoteIn', 'officeOut', 'remoteOut', 'breakIn', 'breakOut'];

  // 3状態 × 6種別 = 18通りを網羅する
  ALL_STATES.forEach(function (state) {
    const allowed = getAllowedTypes(state);
    ALL_TYPES.forEach(function (type) {
      check(
        'getAllowedTypes(' + state + ') が ' + type + ' を含むか',
        allowed.indexOf(type) !== -1,
        ALLOWED_BY_STATE[state].indexOf(type) !== -1
      );
    });
  });

  // allowed の並び順は UI のボタン順の既定になるため、順序込みで確認する
  ALL_STATES.forEach(function (state) {
    check('getAllowedTypes(' + state + ') の全体', getAllowedTypes(state), ALLOWED_BY_STATE[state]);
  });

  // --- deriveState ---
  check('初期状態', deriveState([]), 'offDuty');
  check('出社のみ', deriveState(['officeIn']), 'onDuty');
  check(
    '同日複数ペア',
    deriveState(['officeIn', 'officeOut', 'remoteIn', 'remoteOut']),
    'offDuty'
  );
  check(
    '休憩の入れ子',
    deriveState(['officeIn', 'breakIn', 'breakOut', 'officeOut']),
    'offDuty'
  );
  check('途中終了（休憩中）', deriveState(['officeIn', 'breakIn']), 'onBreak');
  check('形態の混在', deriveState(['officeIn', 'remoteOut']), 'offDuty');

  // 辻褄の合わない列・未知の種別は1件無視して状態を維持する（PLAN.md §2.4）
  check('出社なしの退社は無視', deriveState(['officeOut']), 'offDuty');
  check('勤務中の二重出社は無視', deriveState(['officeIn', 'remoteIn']), 'onDuty');
  check('休憩中の退社は無視', deriveState(['officeIn', 'breakIn', 'officeOut']), 'onBreak');
  check('未知の種別は無視', deriveState(['officeIn', 'start', 'constructor']), 'onDuty');

  Logger.log(
    'testTransitions: ' + (total - failures.length) + '/' + total +
      ' 件合格、失敗 ' + failures.length + ' 件'
  );
  failures.forEach(function (f) {
    Logger.log('  NG ' + f);
  });

  return { total: total, failed: failures.length, failures: failures };
}

/** 打刻の動作確認用ラッパー。6種別ぶん用意する（PLAN.md §5 Phase 1 の注記） */
function testPunchOfficeIn() {
  return logPunch('officeIn');
}

function testPunchRemoteIn() {
  return logPunch('remoteIn');
}

function testPunchOfficeOut() {
  return logPunch('officeOut');
}

function testPunchRemoteOut() {
  return logPunch('remoteOut');
}

function testPunchBreakIn() {
  return logPunch('breakIn');
}

function testPunchBreakOut() {
  return logPunch('breakOut');
}

/** punch() を実行して結果をログに出す */
function logPunch(type) {
  const result = punch(type);
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
