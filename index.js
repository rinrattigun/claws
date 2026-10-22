// Omegaverse Dynamics v0.5 — расширение для SillyTavern
//  • время берётся из инфоблока в чате (дата и часы), а не из счётчика сообщений
//  • настроение читается из поля «Состояние» инфоблока
//  • состояние привязано к сообщениям: свайпы, правки и удаления откатываются
//  • приложение-трекер (app.js): сегодня, партнёр, профиль; на экранах пользователя
//    и партнёра — сводка, кнопки гона/течки, настроение, беременность
//  • настройка пола, вторичного пола, запаха и цикла
//  • авто-события: внезапные течка/гон, скрытая беременность с симптомами
//  • всплывающие окна о событиях, беременности и родах
//  • всё это уходит в промпт модели

import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
    eventSource,
    event_types,
    chat_metadata,
} from '../../../../script.js';
import { initApp } from './app.js';

const MODULE = 'omegaverse_dynamics';
const SETTINGS_KEY = 'omegaverse_dynamics_v2';

// ---------------------------------------------------------------------------
// Справочники
// ---------------------------------------------------------------------------

const GENDERS = {
    alpha: { sym: 'α', ru: 'Альфа', en: 'Alpha', word: 'rut', ruActive: 'Гон', ruPre: 'Предгон' },
    beta: { sym: 'β', ru: 'Бета', en: 'Beta', word: null, ruActive: '', ruPre: '' },
    omega: { sym: 'Ω', ru: 'Омега', en: 'Omega', word: 'heat', ruActive: 'Течка', ruPre: 'Предтечка' },
};

const SEX = {
    male: { sym: '♂', ru: 'мужской', en: 'male' },
    female: { sym: '♀', ru: 'женский', en: 'female' },
};

// [русское название, слово для промпта]
const MOODS = {
    calm: ['Спокойное', 'calm'],
    restless: ['Беспокойное', 'restless'],
    affectionate: ['Ласковое', 'affectionate and clingy'],
    nesting: ['Гнездование', 'nesting, seeking comfort and safety'],
    irritable: ['Раздражённое', 'irritable'],
    aggressive: ['Агрессивное', 'aggressive and domineering'],
    possessive: ['Собственническое', 'possessive and protective'],
    anxious: ['Тревожное', 'anxious'],
    playful: ['Игривое', 'playful'],
    tired: ['Усталое', 'tired and drained'],
    moody: ['Перепады настроения', 'prone to sudden, unexplained mood swings'],
    alert: ['Настороженное', 'alert, wary and tense'],
    aroused: ['Возбуждённое', 'aroused and overwhelmed by desire'],
    sad: ['Печальное', 'sad and withdrawn'],
    content: ['Довольное', 'content and at ease'],
};

// Симптомы скрытой беременности: [заголовок окна, описание]
const SYMPTOMS = {
    mood: ['Эмоциональный фон изменился', 'Внезапные перепады настроения, непривычная слезливость и раздражительность без видимой причины.'],
    cycle: ['Цикл сбился', 'Ожидаемая течка так и не наступила, привычный ритм нарушен.'],
    sick: ['Самочувствие ухудшилось', 'Слабость, головокружение, тошнота и повышенная чувствительность к запахам.'],
};

const DEFAULT_RULES =
    'This story is set in an Omegaverse. People have a secondary gender (Alpha, Beta or Omega) independent of their sex. ' +
    'Alphas are typically strong, dominant, protective and territorial; they have a knot and experience periodic "rut". ' +
    'Omegas are typically perceptive to pheromones; they can bear children regardless of sex, produce slick during heat, and experience periodic "heat". ' +
    'Betas are not affected by heats or ruts, have no strong pheromones, and their neutral scent can dampen the scents of Alphas and Omegas nearby. ' +
    'Scent is a key channel of communication: emotions, attraction and compatibility are expressed through pheromones. ' +
    'A mating bite on the neck creates a bond: the Omega instantly recognizes their Alpha\'s scent, and their scents blend into a unique "third scent". ' +
    'Describe scents, instincts and bodily reactions naturally and in character, according to the current states listed below.';

function defaultPerson(sex, gender) {
    return {
        sex,
        gender,
        scent: '',
        cycleLength: 30,   // дней в цикле
        preDays: 2,        // дней предтечки/предгона
        activeDays: 5,     // дней течки/гона
        fadeDays: 2,       // дней затухания
    };
}

const ICON_GLYPHS = ['Ω', 'α', 'β', '☾', '✦'];

const SETTINGS_DEFAULTS = {
    enabled: true,
    depth: 4,
    autoTick: true,
    daysPerMessage: 1,
    bonded: false,
    syncBond: true,
    termWeeks: 40,
    activeFertility: 70,
    clock: {
        enabled: true,          // брать время из инфоблока в чате
        onMiss: 'hold',         // если время не найдено: 'hold' — стоит, 'step' — +daysPerMessage
        maxJumpDays: 365,       // скачок вперёд больше этого считаем ошибкой модели
        blockTag: 'infoblock',  // тег, внутри которого лежит инфоблок
        customRegex: '',        // свой regex даты: группы d, mon, y, H, M
        moodFromBlock: true,    // настроение из поля «Состояние»
        moodTtl: 3,             // сколько сообщений держать настроение, если поле пропало
    },
    worldRules: DEFAULT_RULES,
    user: defaultPerson('female', 'omega'),
    char: defaultPerson('male', 'alpha'),
    icon: { show: true, color: '#c2a15f', size: 52, opacity: 0.92, glyph: 'Ω', pos: null },
    auto: {
        enabled: true,
        heatMode: 'mixed',      // schedule | random | mixed
        onsetChance: 3,         // % за сообщение
        minGapDays: 7,          // мин. пауза между течками/гонами
        heatUser: true,
        heatChar: true,
        hideForecast: true,     // прятать прогноз начала течки/гона
        popups: true,
        popupChar: true,
        hiddenPreg: true,       // беременность узнаётся по симптомам
        conceiveChance: 0,      // % зачатия за сообщение в течку/гон партнёра
    },
};

const STATE_DEFAULTS = {
    totalDays: 0,
    lastLen: 0,
    lastRollLen: 0,
    clock: null,    // { baseMs, baseDays, lastMs } — привязка дней цикла к дате в чате
    snaps: {},      // снимки состояния «после» каждого обработанного сообщения (по индексу)
    base: null,     // { idx, snap } — состояние до первого обработанного сообщения
    user: { offset: 0, mood: 'auto', preg: null, randomStart: null, sm: null },
    char: { offset: 0, mood: 'auto', preg: null, randomStart: null, sm: null },
};

const DAY_MS = 86400000;

const knotFlags = { user: false, char: false };
let app = null;

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function esc(t) {
    return String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}

function mod(x, m) {
    return ((x % m) + m) % m;
}

function clampInt(v, min, max, def) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = def;
    n = Math.round(n);
    return Math.min(max, Math.max(min, n));
}

// Генератор случайных чисел: при обработке сообщения подменяется на детерминированный,
// чтобы правка или повторная обработка того же сообщения не перебрасывала кубики
let rng = Math.random;

function randInt(a, b) {
    return a + Math.floor(rng() * (b - a + 1));
}

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    const target = keys.reduce((o, k) => o[k], obj);
    target[last] = value;
}

function mergeDefaults(target, def) {
    for (const [k, v] of Object.entries(def)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            if (target[k] === undefined || target[k] === null || typeof target[k] !== 'object') target[k] = {};
            mergeDefaults(target[k], v);
        } else if (target[k] === undefined) {
            target[k] = v;
        }
    }
}

function getSettings() {
    if (!extension_settings[SETTINGS_KEY]) extension_settings[SETTINGS_KEY] = {};
    const s = extension_settings[SETTINGS_KEY];
    mergeDefaults(s, SETTINGS_DEFAULTS);
    // Миграция со старого розового значка и эмодзи-символов
    if (typeof s.icon.color !== 'string' || s.icon.color.toLowerCase() === '#ff5c8a') s.icon.color = SETTINGS_DEFAULTS.icon.color;
    if (!ICON_GLYPHS.includes(s.icon.glyph)) s.icon.glyph = SETTINGS_DEFAULTS.icon.glyph;
    return s;
}

// Состояние хранится отдельно для каждого чата
function getState() {
    if (!chat_metadata[MODULE]) chat_metadata[MODULE] = {};
    const st = chat_metadata[MODULE];
    mergeDefaults(st, STATE_DEFAULTS);
    if (!Array.isArray(st.history)) st.history = [];
    return st;
}

let processing = false;

function saveState() {
    // Ручные изменения (кнопки) попадают в снимок последнего обработанного сообщения,
    // чтобы свайп следующего ответа не стёр их
    if (!processing) {
        const st = getState();
        const keys = Object.keys(st.snaps).map(Number);
        if (keys.length) st.snaps[Math.max(...keys)] = captureState(st);
    }
    saveMetadataDebounced();
}

function captureState(st) {
    return JSON.parse(JSON.stringify({ totalDays: st.totalDays, clock: st.clock, user: st.user, char: st.char }));
}

function restoreState(st, snap) {
    const c = JSON.parse(JSON.stringify(snap));
    st.totalDays = c.totalDays;
    st.clock = c.clock ?? null;
    st.user = c.user;
    st.char = c.char;
    // Календарь: убираем эпизоды «из будущего»
    st.history = (st.history || [])
        .filter(h => h.day <= st.totalDays + 1e-6)
        .map(h => (h.end != null && h.end > st.totalDays ? { ...h, end: null } : h));
}

// Состояние «до» сообщения idx: снимок предыдущего обработанного сообщения или базовый
function findBefore(st, idx) {
    const prev = Object.keys(st.snaps).map(Number).filter(k => k < idx);
    if (prev.length) return st.snaps[Math.max(...prev)];
    if (st.base && st.base.snap && idx <= st.base.idx) return st.base.snap;
    return null;
}

function pruneSnaps(st) {
    const keys = Object.keys(st.snaps).map(Number).sort((a, b) => a - b);
    while (keys.length > 200) delete st.snaps[keys.shift()];
}

function names() {
    const c = getContext();
    return { user: c.name1 || 'Вы', char: c.name2 || 'Персонаж' };
}

function otherOf(who) {
    return who === 'user' ? 'char' : 'user';
}

function heatMode(s) {
    return s.auto.enabled ? s.auto.heatMode : 'schedule';
}

function isHidden(s) {
    return !!(s.auto.enabled && s.auto.hiddenPreg);
}

// Беременность, о которой уже «известно» (не скрытая)
function visiblePreg(st, who) {
    const p = st[who].preg;
    return p && p.revealed !== false ? p : null;
}

// ---------------------------------------------------------------------------
// Цикл
// ---------------------------------------------------------------------------

// У кого «берём» цикл: после метки (bond) гон альфы синхронизируется с течкой омеги
function cycleOwner(s, who) {
    const other = otherOf(who);
    if (s.bonded && s.syncBond && s[who].gender === 'alpha' && s[other].gender === 'omega') return other;
    return who;
}

function phaseInfo(s, st, who) {
    if (s[who].gender === 'beta') return { phase: 'none' };

    const owner = cycleOwner(s, who);
    const src = s[owner];
    const L = clampInt(src.cycleLength, 5, 400, 30);
    let rest = L - 1;
    const A = clampInt(src.activeDays, 1, rest, 5);
    rest -= A;
    const P = clampInt(src.preDays, 0, Math.max(0, rest), 2);
    rest -= P;
    const F = clampInt(src.fadeDays, 0, Math.max(0, rest), 2);

    const preg = st[owner].preg;
    const broken = owner === who && !!(preg && preg.flags && preg.flags.cycle);

    // Режим «внезапно»: расписания нет, течка/гон стартуют случайно
    if (heatMode(s) === 'random') {
        const start = st[owner].randomStart;
        let phase = 'normal';
        let elapsed = 0;
        let daysLeft = 0;
        let sinceEnd = Infinity;
        if (start != null) {
            elapsed = Math.max(0, st.totalDays - start);
            if (elapsed < A) {
                phase = 'active';
                daysLeft = Math.ceil(A - elapsed);
            } else if (elapsed < A + F) {
                phase = 'fade';
            } else {
                sinceEnd = elapsed - (A + F);
            }
        }
        if (broken) phase = 'normal';
        return { phase, day: Math.floor(elapsed), L: null, owner, random: true, broken, daysLeft, daysToActive: null, sinceEnd, A, startAbs: start };
    }

    const day = mod(Math.floor(st.totalDays) + (Number(st[owner].offset) || 0), L);
    const preStart = L - (P + A + F);
    const activeStart = preStart + P;
    const fadeStart = activeStart + A;

    let phase = 'normal';
    if (day >= fadeStart) phase = 'fade';
    else if (day >= activeStart) phase = 'active';
    else if (day >= preStart) phase = 'pre';
    if (broken && phase !== 'normal') phase = 'normal';

    return {
        phase,
        day,
        L,
        owner,
        random: false,
        broken,
        activeStart,
        fadeStart,
        sinceEnd: day,
        daysToActive: day < activeStart ? activeStart - day : L - day + activeStart,
        daysLeft: phase === 'active' ? fadeStart - day : 0,
        A,
        startAbs: Math.floor(st.totalDays) - (day - activeStart),
    };
}

// Цикл непредсказуемый для игрока (прогноз и расписание скрыты)
function isIrregular(s, info) {
    return !!info.random || (heatMode(s) === 'mixed' && !!s.auto.hideForecast);
}

function phaseLabel(gender, phase, info) {
    if (info && info.broken) return 'Сбит';
    if (phase === 'normal') return 'Норма';
    if (phase === 'fade') return 'Затухание';
    if (phase === 'pre') return GENDERS[gender].ruPre;
    if (phase === 'active') return GENDERS[gender].ruActive;
    return '—';
}

// Эпизоды течки/гона в режиме «внезапно» — по ним строится календарь
function openEpisode(owner, day, A) {
    const st = getState();
    const last = [...st.history].reverse().find(h => h.who === owner);
    if (last && last.end == null && day < last.day + A) return;
    st.history.push({ who: owner, day, end: null });
    if (st.history.length > 200) st.history.splice(0, st.history.length - 200);
}

function closeEpisode(owner, day) {
    const st = getState();
    const last = [...st.history].reverse().find(h => h.who === owner && h.end == null);
    if (last) last.end = day;
}

// target: 'active' — начать течку/гон, 'end' — завершить (затухание), 'start' — сбросить цикл
function setCycleDay(who, target) {
    const s = getSettings();
    const st = getState();
    const info = phaseInfo(s, st, who);
    if (info.phase === 'none') {
        toastr.info('У беты нет цикла.');
        return;
    }
    const owner = info.owner;
    const today = Math.floor(st.totalDays);
    if (info.random) {
        const A = clampInt(s[owner].activeDays, 1, 60, 5);
        if (target === 'active') {
            st[owner].randomStart = st.totalDays;
            openEpisode(owner, today, A);
        } else if (target === 'end') {
            st[owner].randomStart = st.totalDays - A;
            closeEpisode(owner, today);
        } else {
            st[owner].randomStart = null;
            closeEpisode(owner, today);
        }
    } else {
        const targetDay = target === 'active' ? info.activeStart : (target === 'end' ? info.fadeStart : 0);
        st[owner].offset = mod(targetDay - Math.floor(st.totalDays), info.L);
    }
    saveState();
}


// Начало/конец течки и гона: пишем эпизод в историю и сразу сообщаем
function activeNow(s, st) {
    const r = {};
    for (const who of ['user', 'char']) {
        const i = phaseInfo(s, st, who);
        r[who] = i.phase === 'active' && !i.broken;
    }
    return r;
}

function trackHeatTransitions(s, st, before, notify = true) {
    const after = activeNow(s, st);
    for (const who of ['user', 'char']) {
        const info = phaseInfo(s, st, who);
        if (info.phase === 'none') continue;
        const owner = info.owner;
        if (!before[who] && after[who]) {
            openEpisode(owner, Math.floor(st.totalDays), info.A);
            if (notify) onsetPopup(who);
        } else if (before[who] && !after[who]) {
            closeEpisode(owner, Math.floor(st.totalDays));
        }
    }
}

function shiftTime(n) {
    const st = getState();
    const before = st.totalDays;
    const wasActive = activeNow(getSettings(), st);
    st.totalDays = Math.max(0, st.totalDays + Number(n));
    if (Number(n) > 0) trackHeatTransitions(getSettings(), st, wasActive);
    // Сдвигаем и привязку к часам чата, иначе следующий инфоблок «перезапишет» ручной сдвиг
    if (st.clock) st.clock.baseDays += st.totalDays - before;
    saveState();
    checkPregEvents();
    checkBirths();
    refreshAll();
}

function cancelPreg(who) {
    const st = getState();
    st[who].preg = null;
    saveState();
    toastr.info('Готово.');
    refreshAll();
}

// ---------------------------------------------------------------------------
// Настроение
// ---------------------------------------------------------------------------

function effectiveMood(s, st, who) {
    const chosen = st[who].mood;
    if (chosen && chosen !== 'auto' && MOODS[chosen]) return chosen;
    const g = s[who].gender;
    const info = phaseInfo(s, st, who);
    const preg = st[who].preg;
    if (preg && preg.flags && preg.flags.mood && info.phase !== 'active') return 'moody';
    // Настроение из «Состояния» последнего инфоблока важнее настроения по фазе
    const sm = st[who].sm;
    if (s.clock.moodFromBlock && sm && sm.key && MOODS[sm.key]) return sm.key;
    if (info.phase === 'none' || info.phase === 'normal') return 'calm';
    if (info.phase === 'fade') return 'tired';
    if (g === 'omega') return info.phase === 'pre' ? 'nesting' : 'affectionate';
    return info.phase === 'pre' ? 'irritable' : 'aggressive';
}

// ---------------------------------------------------------------------------
// Фертильность и беременность
// ---------------------------------------------------------------------------

function conceptionChance(s, st, who, knot, display = false) {
    if (s[who].gender !== 'omega') return null;
    const preg = st[who].preg;
    // Для отображения скрытая беременность не должна выдавать себя
    if (preg && !(display && preg.revealed === false)) return 0;
    const info = phaseInfo(s, st, who);
    const base = {
        normal: 2,
        pre: 10,
        active: clampInt(s.activeFertility, 0, 100, 70),
        fade: 15,
    }[info.phase];
    if (!knot) return base;
    return info.phase === 'active' ? 99 : Math.min(99, base * 2);
}

function pregWeek(st, who) {
    const p = st[who].preg;
    if (!p) return 0;
    return Math.max(0, Math.floor((st.totalDays - p.startDay) / 7));
}

// Журнал событий персонажа (откатывается вместе со снимками при свайпе)
function addLog(who, text) {
    const st = getState();
    if (!Array.isArray(st[who].log)) st[who].log = [];
    st[who].log.push({ day: Math.floor(st.totalDays), text });
    if (st[who].log.length > 60) st[who].log.splice(0, st[who].log.length - 60);
}

function doConceive(who, force) {
    const s = getSettings();
    const st = getState();
    const hidden = isHidden(s);
    if (s[who].gender !== 'omega') {
        flash('Вынашивать беременность может только Омега.', 'fa-circle-info', 'warn');
        return;
    }
    if (st[who].preg) {
        flash(hidden ? 'Близость отмечена.' : 'Беременность уже есть.');
        return;
    }
    if (force) {
        startPregnancy(who, null);
        flash(hidden ? 'Готово. Результат скрыт: признаки проявятся позже.' : 'Беременность началась.', 'fa-person-pregnant', 'good');
        return;
    }
    const chance = conceptionChance(s, st, who, !!knotFlags[who]);
    const ok = Math.random() * 100 < chance;
    if (hidden) {
        // Одинаковое сообщение при успехе и неудаче, чтобы не выдать результат
        addLog(who, knotFlags[who] ? 'Близость с узлом' : 'Близость');
        if (ok) startPregnancy(who, chance);
        saveState();
        flash('Близость отмечена. Если зачатие произошло, первые признаки появятся через несколько дней: следите за самочувствием.', 'fa-heart', 'info', 7000);
    } else if (ok) {
        startPregnancy(who, chance);
    } else {
        addLog(who, `Близость: зачатия не произошло (шанс ~${chance}%)`);
        saveState();
        flash(`Зачатия не произошло (шанс был ~${chance}%).`);
    }
    refreshAll();
}

function startPregnancy(who, chance) {
    const s = getSettings();
    const st = getState();
    const hidden = isHidden(s);

    // Скрытая беременность: симптомы проявляются в случайные моменты, затем — подтверждение
    const events = [];
    if (hidden) {
        let t = randInt(5, 12);
        events.push({ type: 'mood', at: t, done: false });
        t += randInt(5, 10);
        events.push({ type: 'cycle', at: t, done: false });
        t += randInt(3, 8);
        events.push({ type: 'sick', at: t, done: false });
        t += randInt(5, 10);
        events.push({ type: 'reveal', at: t, done: false });
    }

    st[who].preg = {
        startDay: st.totalDays,
        wellbeing: 100,
        birthNotified: false,
        revealed: !hidden,
        confirmedDay: hidden ? null : Math.floor(st.totalDays),
        flags: { mood: false, cycle: false, sick: false },
        events,
    };
    if (!hidden) addLog(who, chance != null ? `Зачатие! Беременность подтверждена (шанс был ~${chance}%)` : 'Беременность подтверждена');
    saveState();
    refreshAll();
    if (!hidden) pregnancyPopup(who, chance);
}

function finishPregnancy(who) {
    const st = getState();
    if (st[who].preg) addLog(who, 'Роды');
    st[who].preg = null;
    saveState();
    refreshAll();
}

function popupAllowed(s, who) {
    return !!(s.auto.popups && (who === 'user' || s.auto.popupChar));
}

// Наступили ли очередные симптомы / подтверждение скрытой беременности
function checkPregEvents() {
    const s = getSettings();
    const st = getState();
    for (const who of ['user', 'char']) {
        const p = st[who].preg;
        if (!p || p.revealed !== false || !Array.isArray(p.events)) continue;
        const elapsed = st.totalDays - p.startDay;
        const due = p.events.filter(e => !e.done && elapsed >= e.at);
        if (!due.length) continue;

        const symptoms = [];
        let reveal = false;
        for (const e of due) {
            e.done = true;
            if (e.type === 'reveal') {
                p.revealed = true;
                p.confirmedDay = Math.floor(st.totalDays);
                addLog(who, 'Беременность подтверждена');
                reveal = true;
            } else {
                p.flags[e.type] = true;
                addLog(who, `Симптом: ${SYMPTOMS[e.type][0]}`);
                symptoms.push(e.type);
                if (e.type === 'sick') p.wellbeing = randInt(45, 65);
            }
        }
        saveState();

        const nm = names()[who];
        if (reveal) pregnancyPopup(who, null, '1');
        if (symptoms.length) eventPopup(who, symptoms);
    }
}

function checkBirths() {
    const s = getSettings();
    const st = getState();
    for (const who of ['user', 'char']) {
        const p = st[who].preg;
        if (p && p.revealed !== false && !p.birthNotified && pregWeek(st, who) >= clampInt(s.termWeeks, 4, 60, 40)) {
            p.birthNotified = true;
            saveState();
            birthPopup(who);
        }
    }
}

// ---------------------------------------------------------------------------
// Авто-события: внезапные течка/гон и зачатие
// ---------------------------------------------------------------------------

function suddenHeat(who, force) {
    setCycleDay(who, 'active');
    onsetPopup(who);
}

function runRandomOnset(s, st) {
    if (!s.auto.enabled || s.auto.heatMode === 'schedule') return;
    const chance = Number(s.auto.onsetChance) || 0;
    if (chance <= 0) return;
    const minGap = Number(s.auto.minGapDays) || 0;

    for (const who of ['user', 'char']) {
        if (!s.auto[who === 'user' ? 'heatUser' : 'heatChar']) continue;
        const info = phaseInfo(s, st, who);
        if (info.phase !== 'normal' || info.broken || info.owner !== who) continue;
        if (st[who].preg) continue;
        if (info.sinceEnd < minGap) continue;
        if (rng() * 100 < chance) suddenHeat(who, false);
    }
}

// Авто-зачатие: бросок за сообщение, пока у омеги идёт течка
function runAutoConception(s, st) {
    if (!s.auto.enabled) return;
    const perMsg = Number(s.auto.conceiveChance) || 0;
    if (perMsg <= 0) return;
    for (const who of ['user', 'char']) {
        if (s[who].gender !== 'omega' || st[who].preg) continue;
        if (s[otherOf(who)].gender !== 'alpha') continue;
        if (phaseInfo(s, st, who).phase !== 'active') continue;
        if (rng() * 100 >= perMsg) continue;
        const chance = conceptionChance(s, st, who, false);
        if (rng() * 100 < chance) startPregnancy(who, chance);
    }
}


// ---------------------------------------------------------------------------
// Время и настроение из инфоблока в чате
// ---------------------------------------------------------------------------

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'ма', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTH_RE = 'январ[яь]|феврал[яь]|март[а]?|апрел[яь]|ма[яй]|июн[яь]|июл[яь]|август[а]?|сентябр[яь]|октябр[яь]|ноябр[яь]|декабр[яь]';

// [настроение, вес, основы слов]; слова ищутся с начала (чтобы «спокой» не совпало с «беспокойство»)
const MOOD_KEYWORDS = [
    ['aggressive', 3, 'агресс|ярост|злост|зл(?:ой|ая|ое|ые|ится|юсь)|оскал|рыч|бешен|враждеб|свирепе'],
    ['possessive', 3, 'собственнич|ревн|оберег|защитн|не отпуска|притязан|метит'],
    ['irritable', 2, 'раздраж|нетерпелив|недовольн|досад|злит|взвинчен'],
    ['anxious', 2, 'тревог|нервн|паник|страх|боит|испуг|волнен|волнуе'],
    ['anxious', 1, 'сердце (?:бьет|колот|стучит)'],
    ['alert', 2, 'насторож|бдитель|начеку|подозрит|напряж|прислушив|принюхив|собран'],
    ['restless', 2, 'беспокой|неусидч|мечет|суетл|не находит себе места'],
    ['affectionate', 2, 'ласк|нежн|прижим|льнет|привязан|довер|влюбл|трепетн'],
    ['nesting', 2, 'гнезд|уют|прячет|укрыва|убежищ'],
    ['playful', 1, 'игрив|азарт|озорн|дразн|весел|шалов|смешлив|ухмыл|задор'],
    ['aroused', 2, 'возбужд|желани|вожделен|томлен|течк|пылает|разгорячен'],
    ['tired', 2, 'устал|утомл|измотан|вымотан|сонн|истощ|обессил|измучен|слабост'],
    ['moody', 2, 'перепад|неустойчив|переменчив|качели'],
    ['sad', 2, 'груст|печал|тоск|подавлен|уныл|слез|плач|расстро'],
    ['content', 1, 'довольн|счастлив|радост|блажен|удовлетвор|сыт'],
    ['calm', 1, 'спокой|умиротвор|расслабл|безмятеж|невозмутим|тих'],
].map(([key, w, src]) => [key, w, new RegExp('(?:^|[^а-я])(?:' + src + ')', 'g')]);

function monthFromWord(w) {
    w = String(w || '').toLowerCase();
    for (let i = 0; i < MONTH_STEMS.length; i++) if (w.startsWith(MONTH_STEMS[i])) return i;
    return null;
}

function fmtMs(ms, withYear = true) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCDate()} ${MONTHS_GEN[d.getUTCMonth()]}${withYear ? ' ' + d.getUTCFullYear() : ''}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Достаём текст инфоблока: последний <infoblock>…</infoblock>, без HTML-разметки
function blockPlain(mes, s) {
    let src = String(mes || '');
    const tag = String(s.clock.blockTag || '').trim();
    if (tag && /^[\w-]+$/.test(tag)) {
        const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)(?:</${tag}>|$)`, 'gi');
        let m;
        let last = null;
        while ((m = re.exec(src))) last = m[1];
        if (last != null && last.trim()) src = last;
    }
    return src.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
}

// «Дата: 18 октября, суббота, 2008 | 16:43 | Погода: …» → момент времени в мс
function parseStoryTime(plain, s, st) {
    let d = null, mon = null, y = null, H = null, M = 0;

    const custom = String(s.clock.customRegex || '').trim();
    if (custom) {
        try {
            const g = new RegExp(custom, 'i').exec(plain)?.groups;
            if (g && g.d) {
                d = +g.d;
                mon = /^\d+$/.test(g.mon || '') ? +g.mon - 1 : monthFromWord(g.mon);
                y = g.y ? +g.y : null;
                H = g.H != null ? +g.H : null;
                M = g.M != null ? +g.M : 0;
            }
        } catch (e) {
            console.warn('[Omegaverse] неверный regex даты', e);
        }
    }

    if (d == null) {
        const text = plain.toLowerCase();
        let scope = text;
        const lab = text.search(/дата\s*:/);
        if (lab >= 0) scope = text.slice(lab).split('\n')[0].split(/\|\s*(?:погод|мест)/)[0].slice(0, 260);

        let m = new RegExp(`(\\d{1,2})(?:-?е|-?го)?\\s+(${MONTH_RE})`).exec(scope);
        if (m) {
            d = +m[1];
            mon = monthFromWord(m[2]);
        } else if ((m = /(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(scope))) {
            d = +m[1];
            mon = +m[2] - 1;
            y = +m[3];
        }
        if (d != null && y == null) {
            const ym = /(?:^|[^\d])(\d{4})(?!\d)/.exec(scope);
            if (ym) y = +ym[1];
        }
        const tm = /(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/.exec(scope);
        if (tm) {
            H = +tm[1];
            M = +tm[2];
        }
    }

    if (d == null || mon == null || d < 1 || d > 31 || mon < 0 || mon > 11) return null;
    const prev = st && st.clock ? new Date(st.clock.lastMs) : null;
    if (y == null) y = prev ? prev.getUTCFullYear() : 2000;
    if (H == null) {
        // Времени нет: если дата та же — оставляем прежние часы, иначе полдень
        H = prev && prev.getUTCDate() === d && prev.getUTCMonth() === mon ? prev.getUTCHours() : 12;
        M = prev && prev.getUTCDate() === d && prev.getUTCMonth() === mon ? prev.getUTCMinutes() : 0;
    }
    return { ms: Date.UTC(y, mon, d, H, M) };
}

// Строки статуса: «♂ Эмметт Каллен (Альфа, вампир) | Состояние: … | Одежда: …»
function parseStatusEntries(plain) {
    const out = [];
    const re = /([^\n|]+?)\s*\(([^)\n]*)\)\s*\|\s*состояни[ея]\s*:\s*([^|\n]+)/gi;
    let m;
    while ((m = re.exec(plain))) {
        out.push({ name: m[1].replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim(), tag: m[2].toLowerCase(), text: m[3].trim() });
    }
    if (out.length) return out;
    // Запасной вариант: строка без скобок
    for (const line of plain.split('\n')) {
        const mm = line.match(/состояни[ея]\s*:\s*([^|\n]+)/i);
        if (!mm) continue;
        const head = line.slice(0, mm.index).split('|')[0];
        out.push({ name: head.replace(/[^\p{L}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim(), tag: '', text: mm[1].trim() });
    }
    return out;
}

// Чья это строка: по имени, а если имя не совпало — по вторичному полу в скобках
function matchWho(entry, s) {
    const toks = x => String(x || '').toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}]+/u).filter(t => t.length >= 3);
    const en = toks(entry.name);
    const n = names();
    const hit = who => toks(n[who]).some(t => en.some(e => e === t || (e.length >= 4 && t.length >= 4 && e.slice(0, 4) === t.slice(0, 4))));
    const byName = ['user', 'char'].filter(hit);
    if (byName.length === 1) return byName[0];

    const gl = /альф/.test(entry.tag) ? 'alpha' : /омег/.test(entry.tag) ? 'omega' : /бет/.test(entry.tag) ? 'beta' : null;
    if (gl) {
        const byGender = ['user', 'char'].filter(w => s[w].gender === gl);
        if (byGender.length === 1) return byGender[0];
    }
    return null;
}

function classifyMood(text) {
    const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
    const score = {};
    const first = {};
    for (const [key, w, re] of MOOD_KEYWORDS) {
        re.lastIndex = 0;
        let cnt = 0;
        let pos = Infinity;
        let m;
        while ((m = re.exec(t))) {
            cnt++;
            pos = Math.min(pos, m.index);
            if (m[0].length === 0) re.lastIndex++;
        }
        if (!cnt) continue;
        score[key] = (score[key] || 0) + w * Math.min(cnt, 2);
        first[key] = Math.min(first[key] ?? Infinity, pos);
    }
    const keys = Object.keys(score);
    if (!keys.length) return null;
    keys.sort((a, b) => score[b] - score[a] || first[a] - first[b]);
    return { key: keys[0] };
}

function seededRng(seedStr) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
        h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Привязываем дни цикла к дате из чата: totalDays = baseDays + (время в чате − baseMs)
function applyClock(s, st, parsed) {
    if (!s.clock.enabled || !parsed) return false;
    const c = st.clock;
    if (!c) {
        st.clock = { baseMs: parsed.ms, baseDays: st.totalDays, lastMs: parsed.ms };
        return true;
    }
    const dd = (parsed.ms - c.lastMs) / DAY_MS;
    if (dd < 0) {
        if (dd < -0.01) toastr.warning(`Время в инфоблоке пошло назад (${fmtMs(parsed.ms)}). Игнорирую.`, 'Omegaverse');
        return true;
    }
    if (dd > clampInt(s.clock.maxJumpDays, 1, 36500, 365)) {
        toastr.warning(`Скачок времени на ${Math.round(dd)} дн. выглядит ошибкой. Игнорирую.`, 'Omegaverse');
        return true;
    }
    c.lastMs = parsed.ms;
    st.totalDays = c.baseDays + (parsed.ms - c.baseMs) / DAY_MS;
    return true;
}

let missWarnedFor = null;

// Времени в сообщении нет (или чтение из чата выключено)
function fallbackTick(s, st) {
    if (s.clock.enabled && s.clock.onMiss !== 'step') {
        const id = getContext().chatId || '';
        if (missWarnedFor !== id) {
            missWarnedFor = id;
            toastr.warning('Не нашёл дату и время в инфоблоке, время стоит на месте. Проверьте тег и формат в настройках.', 'Omegaverse');
        }
        return;
    }
    if (!s.clock.enabled && !s.autoTick) return;
    const add = Math.max(0, Number(s.daysPerMessage) || 0);
    st.totalDays += add;
    if (st.clock) st.clock.baseDays += add;
}

function readMoods(s, st, plain) {
    if (!s.clock.moodFromBlock) return;
    const seen = {};
    for (const e of parseStatusEntries(plain)) {
        const who = matchWho(e, s);
        if (!who || seen[who]) continue;
        seen[who] = true;
        const cl = classifyMood(e.text);
        st[who].sm = { key: cl ? cl.key : null, text: e.text.slice(0, 200), ttl: clampInt(s.clock.moodTtl, 1, 20, 3) };
    }
    for (const who of ['user', 'char']) {
        if (seen[who] || !st[who].sm) continue;
        st[who].sm.ttl -= 1;
        if (st[who].sm.ttl <= 0) st[who].sm = null;
    }
}

function lastBotIdx() {
    const chat = getContext().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

// Обработка одного ответа персонажа. Повторный вызов для того же сообщения (свайп,
// правка) сначала откатывает состояние к тому, что было до него
function processMessage(idx, { anchorOnly = false } = {}) {
    const s = getSettings();
    if (!s.enabled) return;
    const chat = getContext().chat || [];
    const m = chat[idx];
    if (!m || m.is_user || m.is_system) return;

    const st = getState();
    const snaps = st.snaps;
    processing = true;
    const prevRng = rng;
    try {
        if (snaps[idx]) {
            const before = findBefore(st, idx);
            if (before) restoreState(st, before);
        } else if (!Object.keys(snaps).some(k => Number(k) < idx)) {
            st.base = { idx, snap: captureState(st) };
        }
        for (const k of Object.keys(snaps)) if (Number(k) >= idx) delete snaps[k];

        const mes = String(m.mes || '');
        if (mes.trim()) {
            rng = seededRng(`${getContext().chatId || ''}|${idx}|${m.swipe_id ?? 0}|${m.gen_started || m.send_date || ''}`);
            const plain = blockPlain(mes, s);
            const parsed = s.clock.enabled ? parseStoryTime(plain, s, st) : null;
            const wasActive = activeNow(s, st);
            const timed = applyClock(s, st, parsed);
            if (!anchorOnly && !timed) fallbackTick(s, st);
            readMoods(s, st, plain);
            if (!anchorOnly) {
                trackHeatTransitions(s, st, wasActive);
                checkPregEvents();
                runRandomOnset(s, st);
                runAutoConception(s, st);
            }
            if (!anchorOnly || parsed) {
                snaps[idx] = captureState(st);
                pruneSnaps(st);
            }
        }
    } finally {
        processing = false;
        rng = prevRng;
    }
    saveState();
    checkBirths();
}

// Для отображения в приложении и настройках
function clockLabel() {
    const st = getState();
    return st.clock ? fmtMs(st.clock.lastMs) : '';
}

// Проверка без изменения состояния: что расширение «видит» в последнем сообщении
function diagnoseLast() {
    const s = getSettings();
    const st = getState();
    const idx = lastBotIdx();
    if (idx < 0) return toastr.info('В чате нет ответов персонажа.', 'Omegaverse');
    const plain = blockPlain((getContext().chat[idx] || {}).mes, s);
    const t = parseStoryTime(plain, s, st);
    const lines = [t ? `Время: ${esc(fmtMs(t.ms))}` : '<b>Время: не найдено</b>'];
    const entries = parseStatusEntries(plain);
    if (!entries.length) lines.push('<b>Строки «Состояние» не найдены</b>');
    for (const e of entries) {
        const who = matchWho(e, s);
        const cl = classifyMood(e.text);
        lines.push(`${esc(e.name || '?')} → ${who ? esc(names()[who]) : '<b>не опознан</b>'}: ${cl ? esc(MOODS[cl.key][0]) : 'настроение не распознано'}`);
    }
    toastr.info(lines.join('<br>'), 'Omegaverse', { escapeHtml: false, timeOut: 15000 });
}

// Перепривязать часы к последнему сообщению, не трогая текущий день цикла
function rebaseClock() {
    const s = getSettings();
    const st = getState();
    const idx = lastBotIdx();
    const t = idx >= 0 ? parseStoryTime(blockPlain(getContext().chat[idx].mes, s), s, st) : null;
    if (!t) return toastr.warning('Не нашёл дату и время в последнем сообщении.', 'Omegaverse');
    st.clock = { baseMs: t.ms, baseDays: st.totalDays, lastMs: t.ms };
    saveState();
    refreshAll();
    toastr.success(`Время привязано: ${fmtMs(t.ms)}`, 'Omegaverse');
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

// Дата в истории по «дням цикла» (через привязку к часам чата)
function storyDate(st, absDays) {
    const c = st.clock;
    if (!c) return null;
    return fmtMs(c.baseMs + (absDays - c.baseDays) * DAY_MS, false);
}

// Для модели: сколько длится течка/гон и что раньше срока она не заканчивается
function heatTimingText(st, info, name, word) {
    const A = info.A;
    const n = Math.min(A, Math.max(0, Math.floor(st.totalDays - info.startAbs)) + 1);
    const from = storyDate(st, info.startAbs);
    const to = storyDate(st, info.startAbs + A);
    let t = `This ${word} lasts ${A} days of story time; now it is day ${n} of ${A}`;
    if (from && to) t += ` (it began ${from} and will subside around ${to})`;
    t += `. ${name}'s ${word} must not end early or be resolved within a single scene: it goes on until that story time has actually passed.`;
    return t;
}

function personPrompt(s, st, who, name) {
    const p = s[who];
    const g = GENDERS[p.gender];
    const info = phaseInfo(s, st, who);
    const parts = [`${name} is a ${SEX[p.sex].en} ${g.en}.`];

    const scent = (p.scent || '').trim();
    if (scent) parts.push(`Scent: ${scent}.`);

    if (g.word && info.phase === 'pre') {
        parts.push(p.gender === 'omega'
            ? `${name}'s heat is approaching: growing restlessness, nesting urges and heightened sensitivity to scents.`
            : `${name}'s rut is approaching: irritability and sharpening territorial instincts.`);
    } else if (g.word && info.phase === 'active') {
        parts.push(p.gender === 'omega'
            ? `${name} is in heat: heightened sensitivity, a strong urge to nest, intense pheromone release that draws Alphas, high fertility, unstable emotions.`
            : `${name} is in rut: intense drive, aggression and possessiveness, strong pheromones, increased physical strength, reduced self-control.`);
    } else if (g.word && info.phase === 'fade') {
        parts.push(`${name}'s ${g.word} is subsiding: fatigue, returning calm, lingering sensitivity.`);
    }

    if (g.word && info.phase === 'active' && info.startAbs != null) parts.push(heatTimingText(st, info, name, g.word));

    parts.push(`Mood: ${MOODS[effectiveMood(s, st, who)][1]}.`);

    const preg = st[who].preg;
    if (preg) {
        const wb = clampInt(preg.wellbeing, 0, 100, 100);
        if (preg.revealed !== false) {
            const term = clampInt(s.termWeeks, 4, 60, 40);
            let l = `${name} is pregnant (week ${pregWeek(st, who)} of ${term}).`;
            if (p.sex === 'male') l += ' Delivery will be by cesarean section.';
            if (wb < 40) l += ' Their health is poor and they need care and rest.';
            parts.push(l);
        } else {
            // Беременность ещё неизвестна: в промпт попадают только симптомы, без слова «pregnant»
            const f = preg.flags || {};
            if (f.cycle) parts.push(`${name}'s expected heat has not come; their cycle is disrupted for no known reason.`);
            if (f.sick) parts.push(`${name} feels unwell for no clear reason: weakness, dizziness, nausea and heightened sensitivity to smells.`);
        }
    }
    return parts.join(' ');
}

function buildPrompt(s) {
    const st = getState();
    const lines = [s.worldRules.trim()];
    if (s.clock.enabled) {
        lines.push('Story time passes only as shown by the date and time in the status block. Heats and ruts last as many in-story days as stated below: do not shorten, skip or resolve them early.');
    }
    lines.push(personPrompt(s, st, 'user', '{{user}}'));
    lines.push(personPrompt(s, st, 'char', '{{char}}'));
    if (s.bonded) {
        lines.push('{{user}} and {{char}} are bonded: they instantly recognize each other\'s scent, sense each other\'s emotions, and their heat and rut cycles are synchronized.');
    }
    return '[' + lines.filter(Boolean).join('\n') + ']';
}

function updatePrompt() {
    const s = getSettings();
    if (!s.enabled) {
        setExtensionPrompt(MODULE, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const d = Number(s.depth);
    setExtensionPrompt(
        MODULE,
        buildPrompt(s),
        extension_prompt_types.IN_CHAT,
        Number.isFinite(d) ? d : 4,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

// ---------------------------------------------------------------------------
// Тема: цвета берутся из активной темы SillyTavern (светлая/тёмная/любая)
// ---------------------------------------------------------------------------

function parseCssColor(str) {
    const m = String(str || '').match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?/i);
    if (!m) return null;
    let a = m[4] == null ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    if (!Number.isFinite(a)) a = 1;
    return { r: +m[1], g: +m[2], b: +m[3], a };
}

// Переменная темы → цвет (через вычисленный стиль, чтобы раскрылись var()/hex/hsl)
function resolveThemeColor(name) {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
    document.body.appendChild(probe);
    const c = parseCssColor(getComputedStyle(probe).color);
    probe.remove();
    return c;
}

const lum = c => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
const mixC = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: 1 });
const cssC = (c, a = 1) => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
const contrast = (a, b) => { const x = lum(a) + 0.05; const y = lum(b) + 0.05; return Math.max(x, y) / Math.min(x, y); };

let themeSig = '';

function syncTheme() {
    try {
        const text = resolveThemeColor('--SmartThemeBodyColor');
        const tint = resolveThemeColor('--SmartThemeBlurTintColor');
        if (!text || !tint) return;
        const quote = resolveThemeColor('--SmartThemeQuoteColor');
        const em = resolveThemeColor('--SmartThemeEmColor');
        const sig = [text, tint, quote, em].map(c => (c ? cssC(c, c.a) : '-')).join('|');
        if (sig === themeSig) return;
        themeSig = sig;

        // Фон окон всегда непрозрачный: полупрозрачный оттенок темы кладём на тёмную/светлую подложку
        const base = lum(text) > 0.5 ? { r: 12, g: 13, b: 18, a: 1 } : { r: 250, g: 250, b: 250, a: 1 };
        const bg = mixC(base, tint, Math.max(tint.a, 0.9));
        const pick = [quote, em, text].find(c => c && contrast(c, bg) >= 3) || text;
        const dark = lum(bg) < 0.5;
        const vars = {
            '--ov-bg': cssC(bg),
            '--ov-bg2': cssC(mixC(bg, text, 0.06)),
            '--ov-bg3': cssC(mixC(bg, text, 0.12)),
            '--ov-line': cssC(text, 0.14),
            '--ov-line2': cssC(text, 0.28),
            '--ov-text': cssC(text),
            '--ov-dim': cssC(mixC(text, bg, 0.35)),
            '--ov-faint': cssC(mixC(text, bg, 0.6)),
            '--ov-brass': cssC(pick),
            '--ov-brass-d': cssC(mixC(pick, bg, 0.4)),
            '--ov-on-brass': lum(pick) > 0.45 ? '#16130c' : '#ffffff',
            // Фазы цикла: насыщенные тона, читаемые и на светлом, и на тёмном фоне
            '--ov-ember': dark ? '#d4604f' : '#b53a2a',
            '--ov-amber': dark ? '#d3a24f' : '#a8741a',
            '--ov-slate': dark ? '#6f93b8' : '#3f6a96',
            '--ov-stone': cssC(mixC(text, bg, 0.5)),
        };
        const root = document.documentElement.style;
        for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
    } catch (e) {
        console.warn('[Omegaverse] theme sync failed', e);
    }
}

function watchTheme() {
    syncTheme();
    const mo = new MutationObserver(() => syncTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    // Запас на случай смены темы способом, который observer не видит
    setInterval(syncTheme, 3000);
}

// ---------------------------------------------------------------------------
// Модальные окна
// ---------------------------------------------------------------------------

function openModal({ id, title, body, buttons }) {
    $(`#${id}`).remove();
    const $el = $(`
        <div class="ov-backdrop" id="${id}">
            <div class="ov-modal">
                <div class="ov-modal-head"><span>${title}</span><i class="fa-solid fa-xmark ov-modal-x"></i></div>
                <div class="ov-modal-body"></div>
                <div class="ov-modal-foot"></div>
            </div>
        </div>`);
    $el.find('.ov-modal-body').html(body);
    const $foot = $el.find('.ov-modal-foot');
    (buttons || [{ text: 'OK' }]).forEach(b => {
        const $btn = $('<div class="menu_button"></div>').text(b.text);
        $btn.on('click', () => {
            if (b.onClick) b.onClick();
            $el.remove();
        });
        $foot.append($btn);
    });
    $el.on('click', e => {
        if (e.target === $el[0]) $el.remove();
    });
    $el.find('.ov-modal-x').on('click', () => $el.remove());
    $('body').append($el);
    return $el;
}

function symptomsHtml(types) {
    return types
        .map(t => `<div class="ov-sym"><b>${SYMPTOMS[t][0]}</b><div>${SYMPTOMS[t][1]}</div></div>`)
        .join('');
}

// Тонкая всплывающая строка (flash-уведомление): без кнопок, исчезает сама, тап — закрыть
function flash(text, icon = 'fa-circle-info', kind = 'info', ms = 5000) {
    let $box = $('#ov_flash');
    if (!$box.length) $box = $('<div id="ov_flash"></div>').appendTo('body');
    const $it = $(`<div class="ov-flash ov-flash-${kind}"><i class="fa-solid ${icon}"></i><span></span></div>`);
    $it.find('span').text(text);
    const close = () => $it.addClass('ov-flash-out');
    $it.on('click', close);
    $box.append($it);
    while ($box.children().length > 4) $box.children().first().remove();
    setTimeout(close, ms);
    setTimeout(() => $it.remove(), ms + 400);
}

// Внезапный симптом: «что-то не так», без объяснения причины
function eventPopup(who, types) {
    const nm = names()[who];
    types.forEach(t => flash(`${nm}: ${SYMPTOMS[t][0]}`, 'fa-triangle-exclamation', 'warn'));
}

// Начало течки/гона (внезапное или по расписанию)
function onsetPopup(who) {
    const nm = names()[who];
    const word = getSettings()[who].gender === 'omega' ? 'течка' : 'гон';
    flash(`${nm}: началась ${word}`, 'fa-fire', 'heat', 6000);
}

function pregnancyPopup(who, chance, notesHtml = '') {
    const nm = names()[who];
    const term = clampInt(getSettings().termWeeks, 4, 60, 40);
    flash(`${nm}: ${notesHtml ? 'беременность подтверждена' : 'беременность'} (срок ${term} нед.)`, 'fa-person-pregnant', 'good');
}

function birthPopup(who) {
    flash(`${names()[who]}: наступил срок родов`, 'fa-baby', 'good', 7000);
}

// ---------------------------------------------------------------------------
// Поля настроек (общие для панели настроек и быстрого меню)
// ---------------------------------------------------------------------------

const Fields = {
    chk(path, label) {
        const s = getSettings();
        return `<label class="checkbox_label"><input type="checkbox" data-path="${path}" ${getPath(s, path) ? 'checked' : ''} /><span>${label}</span></label>`;
    },
    num(path, label, min, max, step = 1) {
        const s = getSettings();
        return `<div class="ov-row"><label>${label}</label><input type="number" class="text_pole" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${esc(getPath(s, path))}" /></div>`;
    },
    sel(path, label, opts) {
        const s = getSettings();
        return `<div class="ov-row"><label>${label}</label><select class="text_pole" data-path="${path}">${opts
            .map(([v, l]) => `<option value="${v}" ${getPath(s, path) === v ? 'selected' : ''}>${l}</option>`)
            .join('')}</select></div>`;
    },
    txt(path, label, ph) {
        const s = getSettings();
        return `<div class="ov-row"><label>${label}</label><input type="text" class="text_pole" data-path="${path}" placeholder="${esc(ph)}" value="${esc(getPath(s, path))}" /></div>`;
    },
};

function autoPanelHtml(full, withTitle = true) {
    const F = Fields;
    let h = `
        <div class="ov-autopanel">
            ${withTitle ? '<b>Авто-события</b>' : ''}
            ${F.chk('auto.enabled', 'Включить внезапные события')}
            ${F.sel('auto.heatMode', 'Течка / гон', [
                ['schedule', 'По расписанию (цикл)'],
                ['random', 'Внезапно (случайно)'],
                ['mixed', 'Расписание + внезапные'],
            ])}
            ${F.num('auto.onsetChance', 'Шанс начала за сообщение (%)', 0, 100, 0.5)}
            ${F.chk('auto.hiddenPreg', 'Скрытая беременность (сначала симптомы, потом подтверждение)')}
            ${F.chk('auto.popups', 'Уведомления о событиях (строка сверху)')}`;
    if (full) {
        h += `
            ${F.num('auto.minGapDays', 'Мин. пауза между течками (дни)', 0, 365)}
            ${F.chk('auto.heatUser', `Внезапные течка/гон: ${esc(names().user)}`)}
            ${F.chk('auto.heatChar', `Внезапные течка/гон: ${esc(names().char)}`)}
            ${F.chk('auto.hideForecast', 'Прятать прогноз и расписание цикла')}
            ${F.chk('auto.popupChar', 'Уведомления и для событий персонажа')}
            ${F.num('auto.conceiveChance', 'Авто-зачатие за сообщение в течку (%)', 0, 100, 0.5)}`;
    }
    return h + '</div>';
}

function addWandButton(attempt = 0) {
    if ($('#ov_wand_button').length) return;
    const $menu = $('#extensionsMenu');
    if (!$menu.length) {
        if (attempt < 20) setTimeout(() => addWandButton(attempt + 1), 500);
        return;
    }
    const $btn = $(`
        <div id="ov_wand_button" class="list-group-item flex-container flexGap5" title="Omegaverse">
            <div class="fa-solid fa-circle-half-stroke extensionsMenuExtensionButton"></div>
            <span>Omegaverse</span>
        </div>`);
    $btn.on('click', () => app?.open());
    $btn.toggle(!!getSettings().enabled);
    $menu.append($btn);
}

// ---------------------------------------------------------------------------
// Панель настроек (меню расширений)
// ---------------------------------------------------------------------------

function buildSettings() {
    const s = getSettings();
    const F = Fields;

    const person = (who, title, scentPh) => `
        <hr /><b>${title}</b>
        ${F.sel(`${who}.sex`, 'Пол', [['male', 'Мужской ♂'], ['female', 'Женский ♀']])}
        ${F.sel(`${who}.gender`, 'Вторичный пол', [['alpha', 'Альфа α'], ['beta', 'Бета β'], ['omega', 'Омега Ω']])}
        ${F.txt(`${who}.scent`, 'Запах', scentPh)}
        ${F.num(`${who}.cycleLength`, 'Длина цикла (дни)', 5, 400)}
        ${F.num(`${who}.preDays`, 'Предтечка/предгон (дни)', 0, 60)}
        ${F.num(`${who}.activeDays`, 'Течка/гон (дни)', 1, 60)}
        ${F.num(`${who}.fadeDays`, 'Затухание (дни)', 0, 60)}`;

    const html = `
    <div class="ov-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Omegaverse Dynamics</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                ${F.chk('enabled', 'Включить расширение')}
                <div class="menu_button" id="ov_open_app">Открыть приложение</div>

                <hr />
                ${autoPanelHtml(true)}

                <hr /><b>Время из чата</b>
                ${F.chk('clock.enabled', 'Брать время из инфоблока в чате')}
                ${F.txt('clock.blockTag', 'Тег инфоблока', 'infoblock')}
                ${F.sel('clock.onMiss', 'Если время не найдено', [['hold', 'Время стоит'], ['step', 'Прибавлять «дней за сообщение»']])}
                ${F.num('clock.maxJumpDays', 'Макс. скачок вперёд (дни)', 1, 36500)}
                ${F.chk('clock.moodFromBlock', 'Настроение из поля «Состояние»')}
                ${F.num('clock.moodTtl', 'Держать настроение, если поле пропало (сообщений)', 1, 20)}
                ${F.txt('clock.customRegex', 'Свой regex даты (необязательно)', 'группы: d, mon, y, H, M')}
                <div class="ov-row"><span id="ov_clock_status"></span></div>
                <div class="menu_button" id="ov_clock_check">Проверить последнее сообщение</div>
                <div class="menu_button" id="ov_clock_reset">Перепривязать время к чату</div>

                <hr /><b>Время без инфоблока</b>
                ${F.chk('autoTick', 'Время идёт само (если чтение из чата выключено)')}
                ${F.num('daysPerMessage', 'Дней за сообщение', 0, 365, 0.1)}

                <hr /><b>Связь и беременность</b>
                ${F.chk('bonded', 'Пара связана меткой (bond)')}
                ${F.chk('syncBond', 'Синхронизировать течку и гон при связи')}
                ${F.num('activeFertility', 'Фертильность в течку (%)', 0, 100)}
                ${F.num('termWeeks', 'Срок беременности (недели)', 4, 60)}

                ${person('user', 'Вы ({{user}})', 'напр.: мёд и тёплый дождь')}
                ${person('char', 'Персонаж ({{char}})', 'напр.: кедр и дым')}

                <hr /><b>Промпт</b>
                ${F.num('depth', 'Глубина вставки', 0, 50)}
                <label for="ov_worldRules">Правила мира (уходят в промпт, на английском)</label>
                <textarea id="ov_worldRules" class="text_pole" data-path="worldRules">${esc(s.worldRules)}</textarea>
                <div class="menu_button" id="ov_resetRules">Вернуть правила по умолчанию</div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);

    // Один обработчик для всех полей с data-path (и в настройках, и в быстром меню)
    $(document).on('input change', '.ov-settings [data-path], .ov-autopanel [data-path], #ov_app [data-path]', function (e) {
        const $i = $(this);
        const inQuick = $i.closest('#ov_app').length > 0;
        // В приложении текстовые поля применяем только по change, чтобы не терять фокус
        if (inQuick && e.type === 'input' && !['range', 'color'].includes($i.attr('type'))) return;

        const path = $i.data('path');
        let value;
        if ($i.attr('type') === 'checkbox') {
            value = $i.prop('checked');
        } else if ($i.attr('type') === 'number' || $i.attr('type') === 'range') {
            if ($i.val() === '') return;
            value = Number($i.val());
            if (Number.isNaN(value)) return;
        } else {
            value = $i.val();
        }
        setPath(getSettings(), path, value);
        saveSettingsDebounced();
        refreshAll();
    });

    $('#ov_open_app').on('click', () => app?.open());
    $('#ov_clock_check').on('click', diagnoseLast);
    $('#ov_clock_reset').on('click', rebaseClock);
    $('#ov_resetRules').on('click', () => {
        getSettings().worldRules = DEFAULT_RULES;
        saveSettingsDebounced();
        refreshAll();
    });
}

// Подтягивает значения полей настроек из актуальных настроек (если менялись в быстром меню)
function syncSettingsUi() {
    const s = getSettings();
    const cl = clockLabel();
    $('#ov_clock_status').text(cl ? `Время в чате: ${cl} · день истории ${Math.floor(getState().totalDays) + 1}` : 'Время из чата ещё не считано');
    $('.ov-settings [data-path]').each(function () {
        if (this === document.activeElement) return;
        const v = getPath(s, $(this).data('path'));
        if (this.type === 'checkbox') this.checked = !!v;
        else $(this).val(v);
    });
}

// ---------------------------------------------------------------------------
// События и запуск
// ---------------------------------------------------------------------------

function refreshAll() {
    updatePrompt();
    syncSettingsUi();
    $('#ov_wand_button').toggle(!!getSettings().enabled);
    app?.refresh();
}

function msgIndex(arg) {
    const len = (getContext().chat || []).length;
    return Number.isInteger(arg) && arg >= 0 && arg < len ? arg : len - 1;
}

function onMessageReceived(messageId) {
    if (!getSettings().enabled) return;
    processMessage(msgIndex(messageId));
    refreshAll();
}

// Свайп на другой вариант (или начало нового): состояние пересчитывается под показанный текст
function onMessageSwiped(messageId) {
    if (!getSettings().enabled) return;
    processMessage(msgIndex(messageId));
    refreshAll();
}

function onMessageEdited(messageId) {
    if (!getSettings().enabled) return;
    const idx = msgIndex(messageId);
    if (!getState().snaps[idx]) return;
    processMessage(idx);
    refreshAll();
}

// Удалили последние сообщения: возвращаемся к состоянию последнего оставшегося ответа
function onMessageDeleted() {
    if (!getSettings().enabled) return;
    const st = getState();
    const lb = lastBotIdx();
    if (lb >= 0 && st.snaps[lb]) {
        for (const k of Object.keys(st.snaps)) if (Number(k) > lb) delete st.snaps[k];
        restoreState(st, st.snaps[lb]);
        saveMetadataDebounced();
    }
    refreshAll();
}

function onChatChanged() {
    if (!getSettings().enabled) {
        refreshAll();
        return;
    }
    const st = getState();
    // Первый запуск в этом чате: привязываемся к времени последнего ответа
    if (!Object.keys(st.snaps).length) {
        const idx = lastBotIdx();
        if (idx >= 0) processMessage(idx, { anchorOnly: true });
    }
    refreshAll();
}

jQuery(() => {
    getSettings();
    watchTheme();
    app = initApp({
        esc, clampInt, getPath, ICON_GLYPHS,
        GENDERS, SEX, MOODS, Fields, knotFlags,
        getSettings, getState, saveState, saveSettingsDebounced, names,
        phaseInfo, phaseLabel, isIrregular, visiblePreg, pregWeek, effectiveMood, conceptionChance,
        setCycleDay, suddenHeat, doConceive, cancelPreg, shiftTime, birthPopup, finishPregnancy,
        autoPanelHtml, refreshAll, clockLabel,
    });
    buildSettings();
    addWandButton();
    onChatChanged();
    // На телефоне интерфейс ST дорисовывается позже — повторно ставим значок
    setTimeout(refreshAll, 1500);
    window.addEventListener('load', () => refreshAll());

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, onMessageSwiped);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, onMessageEdited);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, onMessageDeleted);
});
