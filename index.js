// Omegaverse Dynamics v0.4 — расширение для SillyTavern
//  • приложение-трекер (app.js): сегодня, календарь, партнёр, профиль
//  • компактный плавающий инфоблок (фаза, настроение, беременность)
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
    showInfoblock: true,
    showChar: true,
    infoCollapsed: false,
    infoPos: null,
    depth: 4,
    autoTick: true,
    daysPerMessage: 1,
    bonded: false,
    syncBond: true,
    termWeeks: 40,
    activeFertility: 70,
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
    user: { offset: 0, mood: 'auto', preg: null, randomStart: null },
    char: { offset: 0, mood: 'auto', preg: null, randomStart: null },
};

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

function randInt(a, b) {
    return a + Math.floor(Math.random() * (b - a + 1));
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

function saveState() {
    saveMetadataDebounced();
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
        return { phase, day: Math.floor(elapsed), L: null, owner, random: true, broken, daysLeft, daysToActive: null, sinceEnd };
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

function shiftTime(n) {
    const st = getState();
    st.totalDays = Math.max(0, st.totalDays + Number(n));
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

function doConceive(who, force) {
    const s = getSettings();
    const st = getState();
    const hidden = isHidden(s);
    if (s[who].gender !== 'omega') {
        toastr.warning('Вынашивать беременность может только Омега.');
        return;
    }
    if (st[who].preg) {
        toastr.info(hidden ? 'Бросок выполнен.' : 'Беременность уже есть.');
        return;
    }
    if (force) {
        startPregnancy(who, null);
        if (hidden) toastr.info('Готово.');
        return;
    }
    const chance = conceptionChance(s, st, who, !!knotFlags[who]);
    if (Math.random() * 100 < chance) {
        startPregnancy(who, chance);
        if (hidden) toastr.info('Бросок выполнен.');
    } else {
        toastr.info(hidden ? 'Бросок выполнен.' : `Зачатия не произошло (шанс был ~${chance}%).`);
    }
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
        flags: { mood: false, cycle: false, sick: false },
        events,
    };
    saveState();
    refreshAll();
    if (!hidden) pregnancyPopup(who, chance);
}

function finishPregnancy(who) {
    const st = getState();
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
                reveal = true;
            } else {
                p.flags[e.type] = true;
                symptoms.push(e.type);
                if (e.type === 'sick') p.wellbeing = randInt(45, 65);
            }
        }
        saveState();

        const nm = names()[who];
        if (popupAllowed(s, who)) {
            if (reveal) pregnancyPopup(who, null, symptomsHtml(symptoms));
            else eventPopup(who, symptoms);
        } else {
            symptoms.forEach(t => toastr.warning(`${nm}: ${SYMPTOMS[t][0]}`));
            if (reveal) toastr.success(`${nm}: беременность подтверждена`);
        }
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
    onsetPopup(who, force);
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
        if (Math.random() * 100 < chance) suddenHeat(who, false);
    }
}

// Авто-зачатие: бросок за сообщение, пока у омеги идёт течка
function runAutoConception(s, st) {
    if (!s.auto.enabled) return;
    const perMsg = Number(s.auto.conceiveChance) || 0;
    if (perMsg <= 0) return;
    const key = (getContext().chat || []).length;
    if (st.lastRollLen === key) return;
    st.lastRollLen = key;

    for (const who of ['user', 'char']) {
        if (s[who].gender !== 'omega' || st[who].preg) continue;
        if (s[otherOf(who)].gender !== 'alpha') continue;
        if (phaseInfo(s, st, who).phase !== 'active') continue;
        if (Math.random() * 100 >= perMsg) continue;
        const chance = conceptionChance(s, st, who, false);
        if (Math.random() * 100 < chance) startPregnancy(who, chance);
    }
}

// ---------------------------------------------------------------------------
// Промпт
// ---------------------------------------------------------------------------

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
// Отрисовка: общие строки с информацией
// ---------------------------------------------------------------------------

const line = (label, value) => `<div class="ov-line"><span>${label}</span><b>${value}</b></div>`;
const bar = (pct, cls) => `<div class="ov-bar ${cls}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;

function infoRows(who) {
    const s = getSettings();
    const st = getState();
    const p = s[who];
    const g = GENDERS[p.gender];
    const nm = names()[who];
    const info = phaseInfo(s, st, who);
    const term = clampInt(s.termWeeks, 4, 60, 40);
    const preg = st[who].preg;
    const shown = visiblePreg(st, who);

    let h = `<div class="ov-person"><div class="ov-name">${esc(nm)}<span class="ov-tag">${g.sym} ${g.ru} · ${SEX[p.sex].sym}</span></div>`;

    if (info.phase === 'none') {
        h += line('Цикл', 'нет (бета)');
    } else {
        const synced = info.owner !== who ? ' (синхр.)' : '';
        const irr = isIrregular(s, info);
        const word = p.gender === 'omega' ? 'Течка' : 'Гон';

        if (info.broken) {
            h += line('Цикл', 'сбит');
        } else if (irr) {
            h += line('Цикл', `нерегулярный${synced}`);
        } else {
            h += line('Цикл', `день ${info.day + 1}/${info.L}${synced}`);
            h += bar(((info.day + 1) / info.L) * 100, `ov-phase-${info.phase}`);
        }
        h += line('Фаза', `<span class="ov-ph ov-phase-${info.phase}">${phaseLabel(p.gender, info.phase, info)}</span>`);
        if (!info.broken) {
            h += line(word, info.phase === 'active'
                ? `идёт, ещё ${info.daysLeft} дн.`
                : (irr ? 'непредсказуемо' : `через ${info.daysToActive} дн.`));
        }
        if (p.gender === 'omega' && !shown) {
            h += line('Фертильность', `~${conceptionChance(s, st, who, false, true)}%`);
        }
    }

    h += line('Настроение', esc(MOODS[effectiveMood(s, st, who)][0]));
    if ((p.scent || '').trim()) h += line('Запах', esc(p.scent.trim()));

    if (shown) {
        const wb = clampInt(shown.wellbeing, 0, 100, 100);
        h += line('Беременность', `неделя ${pregWeek(st, who)}/${term}`);
        h += line('Самочувствие', `${wb}%`);
        h += bar(wb, 'ov-wb');
    } else {
        if (p.gender === 'omega') h += line('Беременность', 'нет');
        if (preg && preg.flags && preg.flags.sick) {
            const wb = clampInt(preg.wellbeing, 0, 100, 100);
            h += line('Самочувствие', `${wb}%`);
            h += bar(wb, 'ov-wb');
        }
    }

    if (s.bonded) h += line('Связь', 'есть метка');
    return h + '</div>';
}

// ---------------------------------------------------------------------------
// Инфоблок
// ---------------------------------------------------------------------------

function ensureInfoblock() {
    let $b = $('#ov_infoblock');
    if ($b.length) return $b;

    $b = $(`
        <div id="ov_infoblock">
            <div class="ov-info-head">
                <span class="ov-info-title">Omegaverse</span>
                <span class="ov-info-btns">
                    <i class="fa-solid fa-mobile-screen-button ov-info-app" title="Приложение"></i>
                    <i class="fa-solid fa-sliders ov-info-quick" title="Быстрое меню"></i>
                    <i class="fa-solid fa-chevron-up ov-info-collapse" title="Свернуть"></i>
                    <i class="fa-solid fa-xmark ov-info-close" title="Скрыть"></i>
                </span>
            </div>
            <div class="ov-info-body"></div>
        </div>`);
    $('body').append($b);

    $b.find('.ov-info-quick').on('click', openQuick);
    $b.find('.ov-info-app').on('click', () => app?.open());
    $b.find('.ov-info-collapse').on('click', () => {
        const s = getSettings();
        s.infoCollapsed = !s.infoCollapsed;
        saveSettingsDebounced();
        renderInfoblock();
    });
    $b.find('.ov-info-close').on('click', () => {
        const s = getSettings();
        s.showInfoblock = false;
        saveSettingsDebounced();
        refreshAll();
    });

    // Перетаскивание за заголовок
    let drag = null;
    $b.find('.ov-info-head').on('pointerdown', function (e) {
        if ($(e.target).closest('.ov-info-btns').length) return;
        const r = $b[0].getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        this.setPointerCapture?.(e.pointerId);
    });
    $(document).on('pointermove', e => {
        if (!drag) return;
        const x = Math.min(window.innerWidth - $b[0].offsetWidth, Math.max(0, e.clientX - drag.dx));
        const y = Math.min(window.innerHeight - 40, Math.max(0, e.clientY - drag.dy));
        $b.css({ left: x, top: y, right: 'auto' });
    });
    $(document).on('pointerup', () => {
        if (!drag) return;
        drag = null;
        const r = $b[0].getBoundingClientRect();
        getSettings().infoPos = { x: r.left, y: r.top };
        saveSettingsDebounced();
    });

    return $b;
}

// Компактная строка для плавающего инфоблока: имя, фаза, настроение, беременность
function miniRows(who) {
    const s = getSettings();
    const st = getState();
    const p = s[who];
    const g = GENDERS[p.gender];
    const info = phaseInfo(s, st, who);
    const shown = visiblePreg(st, who);
    const term = clampInt(s.termWeeks, 4, 60, 40);

    let label;
    let cls;
    let note = '';
    if (info.phase === 'none') {
        label = 'Без цикла';
        cls = 'none';
    } else if (info.broken) {
        label = 'Цикл сбит';
        cls = 'normal';
    } else {
        label = phaseLabel(p.gender, info.phase, info);
        cls = info.phase;
        if (info.phase === 'active') note = `ещё ${info.daysLeft} дн.`;
        else if (!isIrregular(s, info) && (info.phase === 'normal' || info.phase === 'pre')) note = `через ${info.daysToActive} дн.`;
    }

    let h = `<div class="ov-person"><div class="ov-name">${esc(names()[who])}<span class="ov-tag">${g.sym} ${SEX[p.sex].sym}</span></div>`;
    h += `<div class="ov-line"><b class="ov-ph ov-phase-${cls}"><i class="ov-dot"></i>${label}</b><span>${note}</span></div>`;
    h += `<div class="ov-line"><span>${esc(MOODS[effectiveMood(s, st, who)][0])}</span></div>`;
    if (shown) h += `<div class="ov-line"><span>Беременность</span><b>нед. ${pregWeek(st, who)}/${term}</b></div>`;
    return h + '</div>';
}

function renderInfoblock() {
    const s = getSettings();
    if (!s.enabled || !s.showInfoblock) {
        $('#ov_infoblock').hide();
        return;
    }
    const $b = ensureInfoblock();
    $b.show().toggleClass('ov-collapsed', !!s.infoCollapsed);
    $b.find('.ov-info-collapse').toggleClass('fa-chevron-up', !s.infoCollapsed).toggleClass('fa-chevron-down', !!s.infoCollapsed);
    if (s.infoPos) {
        const x = Math.min(window.innerWidth - ($b.outerWidth() || 176), Math.max(0, s.infoPos.x));
        const y = Math.min(window.innerHeight - 40, Math.max(0, s.infoPos.y));
        $b.css({ left: x, top: y, right: 'auto' });
    }
    $b.find('.ov-info-body').html(miniRows('user') + (s.showChar ? miniRows('char') : ''));
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

// Внезапный симптом: «что-то не так», без объяснения причины
function eventPopup(who, types) {
    const nm = names()[who];
    const body = `
        <div class="ov-preg">
            <div class="ov-preg-icon"><i class="fa-solid fa-triangle-exclamation"></i></div>
            <div class="ov-preg-title"><b>${esc(nm)}</b> замечает перемены</div>
        </div>
        ${symptomsHtml(types)}`;
    openModal({ id: `ov_event_${who}`, title: 'Что-то изменилось', body });
}

function onsetPopup(who, force) {
    const s = getSettings();
    const p = s[who];
    const nm = names()[who];
    const omega = p.gender === 'omega';
    const title = omega ? 'Внезапная течка' : 'Внезапный гон';
    if (!force && !popupAllowed(s, who)) {
        toastr.warning(`${nm}: ${title.toLowerCase()}`);
        return;
    }
    const text = omega
        ? 'Тело внезапно «срывается»: жар, ломота, резкий выброс феромонов, острая чувствительность и тяга к близости и гнездованию.'
        : 'Резкий прилив сил и агрессии, обострение запахов, собственнические инстинкты — держать себя в руках всё труднее.';
    const body = `
        <div class="ov-preg">
            <div class="ov-preg-icon"><i class="fa-solid fa-fire"></i></div>
            <div class="ov-preg-title"><b>${esc(nm)}</b>: ${title.toLowerCase()}!</div>
            <div class="ov-preg-sub">${GENDERS[p.gender].sym} ${GENDERS[p.gender].ru} · ${SEX[p.sex].sym}</div>
            <div class="ov-preg-sub">${text}</div>
        </div>`;
    openModal({ id: `ov_onset_${who}`, title, body });
}

function pregnancyPopup(who, chance, notesHtml = '') {
    const s = getSettings();
    const p = s[who];
    const nm = names()[who];
    const term = clampInt(s.termWeeks, 4, 60, 40);
    const body = `
        ${notesHtml}
        <div class="ov-preg">
            <div class="ov-preg-icon"><i class="fa-solid fa-person-pregnant"></i></div>
            <div class="ov-preg-title"><b>${esc(nm)}</b> — беременность${notesHtml ? ' подтверждена' : ''}!</div>
            <div class="ov-preg-sub">${GENDERS[p.gender].sym} ${GENDERS[p.gender].ru} · ${SEX[p.sex].sym}</div>
            <div class="ov-preg-sub">Срок: ${term} нед. (~${term * 7} дн. истории)</div>
            ${chance != null ? `<div class="ov-preg-sub">Шанс зачатия был ~${chance}%</div>` : ''}
            ${p.sex === 'male' ? '<div class="ov-preg-sub">Роды будут путём кесарева сечения.</div>' : ''}
        </div>`;
    openModal({ id: `ov_preg_${who}`, title: 'Беременность', body });
}

function birthPopup(who) {
    const s = getSettings();
    const p = s[who];
    const nm = names()[who];
    const term = clampInt(s.termWeeks, 4, 60, 40);
    const body = `
        <div class="ov-preg">
            <div class="ov-preg-icon"><i class="fa-solid fa-baby"></i></div>
            <div class="ov-preg-title">У <b>${esc(nm)}</b> наступил срок родов</div>
            <div class="ov-preg-sub">Достигнуто ${term} нед.</div>
            ${p.sex === 'male' ? '<div class="ov-preg-sub">Роды — кесарево сечение.</div>' : ''}
        </div>`;
    openModal({
        id: `ov_birth_${who}`,
        title: 'Роды',
        body,
        buttons: [
            { text: 'Родить (завершить)', onClick: () => finishPregnancy(who) },
            { text: 'Позже' },
        ],
    });
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
            ${F.chk('auto.hiddenPreg', 'Скрытая беременность (узнаём по симптомам)')}
            ${F.chk('auto.popups', 'Всплывающие окна о событиях')}`;
    if (full) {
        h += `
            ${F.num('auto.minGapDays', 'Мин. пауза между течками (дни)', 0, 365)}
            ${F.chk('auto.heatUser', `Внезапные течка/гон: ${esc(names().user)}`)}
            ${F.chk('auto.heatChar', `Внезапные течка/гон: ${esc(names().char)}`)}
            ${F.chk('auto.hideForecast', 'Прятать прогноз и расписание цикла')}
            ${F.chk('auto.popupChar', 'Окна и для событий персонажа')}
            ${F.num('auto.conceiveChance', 'Авто-зачатие за сообщение в течку (%)', 0, 100, 0.5)}`;
    }
    return h + '</div>';
}

// ---------------------------------------------------------------------------
// Быстрое меню («волшебная палочка»)
// ---------------------------------------------------------------------------

function quickCard(who) {
    const s = getSettings();
    const st = getState();
    const p = s[who];
    const info = phaseInfo(s, st, who);
    const mood = st[who].mood;
    const pv = visiblePreg(st, who);

    let h = `<div class="ov-card">${infoRows(who)}<div class="ov-actions">`;

    if (info.phase !== 'none') {
        const w = p.gender === 'omega' ? 'течку' : 'гон';
        h += `<div class="menu_button" data-action="startActive" data-who="${who}">Начать ${w}</div>`;
        h += `<div class="menu_button" data-action="suddenHeat" data-who="${who}">Внезапно (с окном)</div>`;
        h += `<div class="menu_button" data-action="resetCycle" data-who="${who}">Сбросить цикл</div>`;
    }

    h += `<select class="text_pole" data-mood="${who}"><option value="auto" ${mood === 'auto' ? 'selected' : ''}>Настроение: авто</option>`;
    for (const [key, [ru]] of Object.entries(MOODS)) {
        h += `<option value="${key}" ${mood === key ? 'selected' : ''}>${ru}</option>`;
    }
    h += '</select>';

    if (p.gender === 'omega') {
        if (pv) {
            const wb = clampInt(pv.wellbeing, 0, 100, 100);
            h += `<label style="width:100%">Самочувствие: <input type="range" min="0" max="100" value="${wb}" data-wb="${who}" /></label>`;
            h += `<div class="menu_button" data-action="birth" data-who="${who}">Роды</div>`;
        } else {
            h += `<label class="checkbox_label"><input type="checkbox" data-knot="${who}" ${knotFlags[who] ? 'checked' : ''} /><span>Узел (knotting)</span></label>`;
            h += `<div class="menu_button" data-action="conceive" data-who="${who}">Бросок зачатия</div>`;
            h += `<div class="menu_button" data-action="forcePreg" data-who="${who}">Беременность без броска</div>`;
        }
        h += `<div class="menu_button" data-action="cancelPreg" data-who="${who}">Сбросить беременность</div>`;
    }
    return h + '</div></div>';
}

function renderQuick() {
    const s = getSettings();
    const st = getState();
    const $body = $('#ov_quick .ov-modal-body');
    if (!$body.length) return;

    const html = `
        <div class="ov-actions">
            <span>День истории: <b>${Math.floor(st.totalDays)}</b></span>
            <div class="menu_button" data-action="time" data-n="-1">−1 д</div>
            <div class="menu_button" data-action="time" data-n="1">+1 д</div>
            <div class="menu_button" data-action="time" data-n="7">+7 д</div>
        </div>
        <label class="checkbox_label"><input type="checkbox" data-path="showInfoblock" ${s.showInfoblock ? 'checked' : ''} /><span>Показывать инфоблок</span></label>
        <div class="ov-card">${autoPanelHtml(false)}</div>
        ${quickCard('user')}
        ${quickCard('char')}`;
    $body.html(html);
}

function handleAction(action, who, n) {
    if (action === 'time') {
        shiftTime(n);
    } else if (action === 'startActive') {
        setCycleDay(who, 'active');
    } else if (action === 'suddenHeat') {
        suddenHeat(who, true);
    } else if (action === 'resetCycle') {
        setCycleDay(who, 'start');
    } else if (action === 'conceive') {
        doConceive(who, false);
    } else if (action === 'forcePreg') {
        doConceive(who, true);
    } else if (action === 'cancelPreg') {
        cancelPreg(who);
    } else if (action === 'birth') {
        birthPopup(who);
    }
    refreshAll();
}

function openQuick() {
    const $el = openModal({
        id: 'ov_quick',
        title: 'Omegaverse — быстрое меню',
        body: '',
        buttons: [{ text: 'Закрыть' }],
    });

    $el.on('click', '[data-action]', function () {
        handleAction($(this).data('action'), $(this).data('who'), $(this).data('n'));
    });
    $el.on('change', 'select[data-mood]', function () {
        getState()[$(this).data('mood')].mood = $(this).val();
        saveState();
        refreshAll();
    });
    $el.on('change', 'input[data-wb]', function () {
        const who = $(this).data('wb');
        const preg = getState()[who].preg;
        if (preg) preg.wellbeing = Number($(this).val());
        saveState();
        refreshAll();
    });
    $el.on('change', 'input[data-knot]', function () {
        knotFlags[$(this).data('knot')] = $(this).prop('checked');
    });

    renderQuick();
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
                ${F.chk('showInfoblock', 'Показывать инфоблок')}
                ${F.chk('showChar', 'Показывать персонажа в инфоблоке')}
                <div class="menu_button" id="ov_open_app">Открыть приложение</div>
                <div class="menu_button" id="ov_open_quick">Быстрое меню</div>

                <hr />
                ${autoPanelHtml(true)}

                <hr /><b>Время</b>
                ${F.chk('autoTick', 'Время идёт само (с каждым ответом персонажа)')}
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
    $(document).on('input change', '.ov-settings [data-path], .ov-autopanel [data-path], #ov_quick [data-path], #ov_app [data-path]', function (e) {
        const $i = $(this);
        const inQuick = $i.closest('#ov_quick, #ov_app').length > 0;
        // В быстром меню текстовые поля применяем только по change, чтобы не терять фокус
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
    $('#ov_open_quick').on('click', openQuick);
    $('#ov_resetRules').on('click', () => {
        getSettings().worldRules = DEFAULT_RULES;
        saveSettingsDebounced();
        refreshAll();
    });
}

// Подтягивает значения полей настроек из актуальных настроек (если менялись в быстром меню)
function syncSettingsUi() {
    const s = getSettings();
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
    renderInfoblock();
    renderQuick();
    syncSettingsUi();
    app?.refresh();
}

function onMessageReceived() {
    const s = getSettings();
    const st = getState();
    const len = (getContext().chat || []).length;
    // Время идёт только когда в чате реально прибавилось сообщений (свайпы не считаются)
    const isNew = len > st.lastLen;
    if (s.autoTick && isNew) {
        st.totalDays += Math.max(0, Number(s.daysPerMessage) || 0);
    }
    st.lastLen = len;
    if (isNew) {
        checkPregEvents();
        runRandomOnset(s, st);
        runAutoConception(s, st);
    }
    saveState();
    checkBirths();
    refreshAll();
}

function onChatChanged() {
    const st = getState();
    st.lastLen = (getContext().chat || []).length;
    refreshAll();
}

jQuery(() => {
    getSettings();
    app = initApp({
        esc, clampInt, getPath, ICON_GLYPHS,
        GENDERS, SEX, MOODS, Fields, knotFlags,
        getSettings, getState, saveState, saveSettingsDebounced, names,
        phaseInfo, isIrregular, visiblePreg, pregWeek, effectiveMood, conceptionChance,
        setCycleDay, suddenHeat, doConceive, cancelPreg, shiftTime, birthPopup,
        autoPanelHtml, openQuick, refreshAll,
    });
    buildSettings();
    addWandButton();
    onChatChanged();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
});
