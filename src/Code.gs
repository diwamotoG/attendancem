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
 *           displayName: ?string, guests: string[], error: ?string}}
 */
function getStatus() {
  const now = new Date();
  const status = {
    date: Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd'),
    punches: [],
    state: INITIAL_STATE,
    allowed: getAllowedTypes(INITIAL_STATE),
    displayName: null,
    guests: [],
    error: null,
  };

  try {
    status.guests = getGuestEmails();
  } catch (e) {
    status.error = e.message;
  }

  try {
    status.displayName = getDisplayName();
  } catch (e) {
    status.error = status.error || '氏名の読み込みに失敗しました: ' + e.message;
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
 * 種別 → 招待先 → 氏名 → ロック → 連打しきい値 → 状態遷移 とする。
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

  // 氏名が無いまま作成すると、typeOfTitle() が打刻として認識しないタイトルになり、
  // 作成した本人が履歴でも状態導出でも見つけられない（ADR-0023 / ADR-0024）。
  // 「氏名なしで打刻する」は選べない。
  let displayName;
  try {
    displayName = getDisplayName();
  } catch (e) {
    return { ok: false, error: '氏名の読み込みに失敗しました: ' + e.message, status: getStatus() };
  }
  if (!displayName) {
    return {
      ok: false,
      error: '氏名が未設定です。画面の設定欄から氏名を登録してください',
      status: getStatus(),
    };
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

    const title = buildEventTitle(def, displayName);
    getCalendar().createEvent(
      title,
      now,
      new Date(now.getTime() + EVENT_DURATION_MS),
      {
        guests: guests.join(','),
        sendInvites: def.sendInvites,
      }
    );

    return {
      ok: true,
      message: '「' + title + '」を ' + formatTime(now) + ' で登録しました',
      status: getStatus(),
    };
  } catch (e) {
    return { ok: false, error: '打刻に失敗しました: ' + e.message, status: getStatus() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 氏名を保存する。画面の入力欄から呼ばれる（PLAN.md §4.1 / ADR-0024）。
 *
 * punch() と同じく例外を投げず、ok フラグで結果を表現する。
 * 検証は validateDisplayName()（Config.gs）に集約してある。
 * 値はそのままカレンダーのタイトルに載るため、クライアント側の検証を信用しない。
 *
 * 過去のイベントのタイトルは書き換えない。
 * カレンダーが唯一の記録先であり、ツールが過去の記録を遡って変更しない方針を維持する。
 *
 * @param {string} name
 * @return {{ok: boolean, message?: string, error?: string, status: Object}}
 */
function setDisplayName(name) {
  const result = validateDisplayName(name);
  if (!result.ok) {
    return { ok: false, error: result.error, status: getStatus() };
  }

  try {
    PropertiesService.getUserProperties().setProperty(PROP_DISPLAY_NAME, result.name);
  } catch (e) {
    return { ok: false, error: '氏名の保存に失敗しました: ' + e.message, status: getStatus() };
  }

  return {
    ok: true,
    message: '氏名を「' + result.name + '」に設定しました',
    status: getStatus(),
  };
}

// ---------------------------------------------------------------------------
// 状態遷移とタイトル（純粋関数）
//
// このセクションの関数は CalendarApp / PropertiesService / new Date() に触れない。
// これが testTransitions() / testTitles() による自動検証が成立する条件であり、
// ADR-0021 が punch() に課した制約でもある。遷移の判定をここから
// punch() の中に移すと、テストは通るのに本番が壊れる状態になりうる。
//
// 氏名は引数で受け取る。buildEventTitle() が getDisplayName() を呼ぶと
// User Properties に依存して純粋性が壊れ、自動テストの対象から外れる（PLAN.md §6.1）。
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

/**
 * カレンダー上のイベントタイトルを組み立てる（ADR-0023）。
 *
 * @param {Object} def PUNCH_TYPES の要素
 * @param {string} name 氏名。validateDisplayName() を通った値であること
 * @return {string} 例: 'リアル出社_山田太郎'
 */
function buildEventTitle(def, name) {
  return def.title + TITLE_SEPARATOR + name;
}

/**
 * イベントタイトルから打刻種別を引く（ADR-0023 / PLAN.md §2.4）。
 *
 * タイトルを最初の TITLE_SEPARATOR で1回だけ分割し、
 * 前半が種別名と完全一致するかで判定する。**前方一致では判定しない。**
 * 分割してから完全一致するため、種別部分の判定強度は ADR-0017 と同じである。
 *
 * 区切りを含まない旧形式（氏名なし）は打刻として認識しない。移行もしない。
 * 区切りより後ろが空のタイトルも打刻ではない。
 *
 * @return {?string} PUNCH_TYPES のキー。打刻イベントでなければ null
 */
function typeOfTitle(title) {
  const raw = String(title == null ? '' : title);
  const at = raw.indexOf(TITLE_SEPARATOR);

  // at === -1: 区切りが無い（旧形式）
  // at === 0: 前半が空
  // at === raw.length - 1: 後半（氏名）が空
  if (at <= 0 || at === raw.length - 1) {
    return null;
  }

  const head = raw.slice(0, at);
  for (const key in PUNCH_TYPES) {
    if (PUNCH_TYPES[key].title === head) {
      return key;
    }
  }
  return null;
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

/**
 * タイトルの生成と種別判定の自動テスト（PLAN.md §6.1 / ADR-0023）。
 *
 * カレンダーにも User Properties にも触れず、純粋関数だけを検証する。
 * 期待値は PLAN.md §2.4 の判定表を手で写したものである。
 *
 * 改修前の testTransitions() はタイトル判定を一切検証していなかった。
 * 判定規則が完全一致から「分割 + 完全一致」に変わり誤判定の余地が増えたため新設した。
 *
 * @return {{total: number, failed: number, failures: string[]}}
 */
function testTitles() {
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

  const NAME = '山田太郎';

  // --- 生成 ---
  check(
    'buildEventTitle(officeIn)',
    buildEventTitle(PUNCH_TYPES.officeIn, NAME),
    'リアル出社_' + NAME
  );
  check(
    'buildEventTitle(breakOut)',
    buildEventTitle(PUNCH_TYPES.breakOut, NAME),
    '休憩終了_' + NAME
  );

  // --- 往復: 6種別すべてで 生成 → 判定 が元の type に戻る ---
  ['officeIn', 'remoteIn', 'officeOut', 'remoteOut', 'breakIn', 'breakOut'].forEach(
    function (key) {
      check(
        '往復(' + key + ')',
        typeOfTitle(buildEventTitle(PUNCH_TYPES[key], NAME)),
        key
      );
    }
  );

  // --- PLAN.md §2.4 の判定表の写し ---
  check('氏名に区切りを含む', typeOfTitle('リアル出社_山田_太郎'), 'officeIn');
  check('旧形式（氏名なし）', typeOfTitle('リアル出社'), null);
  check('氏名が空', typeOfTitle('リアル出社_'), null);
  check('種別名が空', typeOfTitle('_山田太郎'), null);
  check('部分一致は拾わない', typeOfTitle('リアル出社について_議事録'), null);
  check('打刻外（区切りあり）', typeOfTitle('定例MTG_山田太郎'), null);
  check('打刻外（区切りなし）', typeOfTitle('ミーティング'), null);
  check('改訂前の開始', typeOfTitle('開始'), null);
  check('空文字', typeOfTitle(''), null);
  check('null', typeOfTitle(null), null);

  // 分割は最初の区切りのみ。前方一致ではなく分割 + 完全一致であることの検証
  check('氏名が種別名と同じ', typeOfTitle('休憩開始_リアル出社'), 'breakIn');

  // --- validateDisplayName（PLAN.md §4.1 の検証規則） ---
  check('氏名: 前後の空白を除去', validateDisplayName('  山田太郎  ').name, '山田太郎');
  check('氏名: 区切りを含んでよい', validateDisplayName('山田_太郎').ok, true);
  check('氏名: 空文字は拒否', validateDisplayName('').ok, false);
  check('氏名: 空白のみは拒否', validateDisplayName('   ').ok, false);
  check('氏名: null は拒否', validateDisplayName(null).ok, false);
  check('氏名: 改行を含むと拒否', validateDisplayName('山田\n太郎').ok, false);
  check('氏名: タブを含むと拒否', validateDisplayName('山田\t太郎').ok, false);
  check(
    '氏名: 上限ちょうどは許可',
    validateDisplayName('あ'.repeat(DISPLAY_NAME_MAX_LENGTH)).ok,
    true
  );
  check(
    '氏名: 上限超過は拒否',
    validateDisplayName('あ'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)).ok,
    false
  );

  Logger.log(
    'testTitles: ' + (total - failures.length) + '/' + total +
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
