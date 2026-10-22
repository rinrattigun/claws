// Omegaverse Dynamics — «приложение» в стиле трекера цикла.
// Плавающий значок открывает приложение: Сегодня / Партнёр / Профиль.

const PH_COLOR = {
    normal: '#6c6b73',
    pre: '#d3a24f',
    active: '#c4503f',
    fade: '#6f93b8',
    none: '#5e5d66',
};

const TABS = [
    ['today', 'fa-heart-pulse', 'Сегодня'],
    ['partner', 'fa-user-group', 'Партнёр'],
    ['profile', 'fa-circle-user', 'Профиль'],
];

export function initApp(api) {
    const { esc, clampInt } = api;

    let tab = 'today';
    let sheet = null;
    let openSec = 'me';
    let isOpen = false;

    const S = () => api.getSettings();
    const ST = () => api.getState();

    const wordsFor = gender => (gender === 'omega'
        ? { nom: 'Течка', gen: 'течки', acc: 'течку' }
        : { nom: 'Гон', gen: 'гона', acc: 'гон' });

    // -----------------------------------------------------------------------
    // Кольцо цикла
    // -----------------------------------------------------------------------

    function dotsSvg(who, info, R) {
        const s = S();
        const st = ST();
        const L = info.L;
        const dotR = Math.max(1.3, Math.min(4, 250 / L));
        const base = Math.floor(st.totalDays);
        let out = '';
        for (let i = 0; i < L; i++) {
            const ph = api.phaseInfo(s, Object.assign({}, st, { totalDays: base + (i - info.day) }), who).phase;
            const ang = ((-90 + (360 * i) / L) * Math.PI) / 180;
            const x = 100 + R * Math.cos(ang);
            const y = 100 + R * Math.sin(ang);
            const isToday = i === info.day;
            out += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${isToday ? dotR + 2.5 : dotR}" fill="${PH_COLOR[ph] || PH_COLOR.normal}"${ph === 'normal' ? ' fill-opacity=".35"' : ''}${isToday ? ' style="stroke:var(--ov-text)" stroke-width="2.5"' : ''}/>`;
        }
        return out;
    }

    function heroHtml(who) {
        const s = S();
        const st = ST();
        const p = s[who];
        const info = api.phaseInfo(s, st, who);
        const shown = api.visiblePreg(st, who);
        const term = clampInt(s.termWeeks, 4, 60, 40);
        const W = wordsFor(p.gender);
        const R = 86;
        const C = 2 * Math.PI * R;

        const track = `<circle cx="100" cy="100" r="${R}" fill="none" style="stroke:var(--ov-line)" stroke-width="8"/>`;
        const arc = (f, col, op = 1) => `<circle cx="100" cy="100" r="${R}" fill="none" stroke="${col}" stroke-opacity="${op}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(C * Math.max(0, Math.min(1, f))).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 100 100)"/>`;

        let svg = track;
        let label = '';
        let big = '';
        let sub = '';

        if (shown) {
            const w = api.pregWeek(st, who);
            const wb = clampInt(shown.wellbeing, 0, 100, 100);
            label = 'Беременность';
            big = `Неделя ${w}`;
            sub = `из ${term} · самочувствие ${wb}%`;
            svg += arc(w / term, PH_COLOR.active);
        } else if (info.phase === 'none') {
            label = 'Бета';
            big = 'Цикла нет';
            sub = 'нейтральный фон';
        } else if (info.broken) {
            label = 'Цикл';
            big = 'Сбит';
            sub = `ожидаемая ${W.nom.toLowerCase()} не наступила`;
            svg += arc(1, PH_COLOR.pre, 0.35);
        } else {
            const irr = api.isIrregular(s, info);
            const dots = !irr && !info.random && info.L <= 400;
            if (dots) svg = dotsSvg(who, info, R);

            if (info.phase === 'active') {
                const A = info.random
                    ? clampInt(s[info.owner].activeDays, 1, 60, 5)
                    : info.fadeStart - info.activeStart;
                const dn = info.random ? info.day + 1 : info.day - info.activeStart + 1;
                label = W.nom;
                big = 'идёт';
                sub = `день ${dn} · ещё ${info.daysLeft} дн.`;
                if (!dots) svg += arc((dn - 1) / Math.max(1, A), PH_COLOR.active);
            } else if (info.phase === 'fade') {
                label = 'Затухание';
                big = 'спад';
                sub = `${W.nom.toLowerCase()} заканчивается`;
                if (!dots) svg += arc(1, PH_COLOR.fade, 0.6);
            } else if (info.phase === 'pre') {
                label = api.GENDERS[p.gender].ruPre;
                big = irr ? 'скоро' : `${info.daysToActive} дн.`;
                sub = irr ? 'организм готовится' : `до ${W.gen}`;
                if (!dots) svg += arc(1, PH_COLOR.pre, 0.6);
            } else {
                label = 'Норма';
                big = irr ? 'Нерегулярно' : `${info.daysToActive} дн.`;
                sub = irr ? 'начало непредсказуемо' : `до ${W.gen}`;
                if (!dots) svg += arc(1, PH_COLOR.normal, 0.25);
            }
        }

        return `
        <div class="ova-ring">
            <svg viewBox="0 0 200 200">${svg}</svg>
            <div class="ova-ring-c">
                <div class="ova-ring-l">${esc(label)}</div>
                <div class="ova-ring-b${big.length > 8 ? ' sm' : ''}">${esc(big)}</div>
                <div class="ova-ring-s">${esc(sub)}</div>
            </div>
        </div>`;
    }

    // -----------------------------------------------------------------------
    // Карточки и советы
    // -----------------------------------------------------------------------

    function wellbeingOf(who) {
        const p = ST()[who].preg;
        if (!p) return null;
        if (p.revealed !== false || (p.flags && p.flags.sick)) return clampInt(p.wellbeing, 0, 100, 100);
        return null;
    }

    function cardsHtml(who) {
        const s = S();
        const st = ST();
        const p = s[who];
        const shown = api.visiblePreg(st, who);
        const m = api.effectiveMood(s, st, who);
        const scent = (p.scent || '').trim();
        const cards = [
            ['Настроение', 'fa-face-smile', esc(api.MOODS[m][0])],
            ['Запах', 'fa-wind', scent ? esc(scent) : 'не задан'],
        ];
        if (p.gender === 'omega' && !shown) {
            cards.push(['Фертильность', 'fa-seedling', `~${api.conceptionChance(s, st, who, false, true)}%`]);
        }
        const wb = wellbeingOf(who);
        if (wb != null) cards.push(['Самочувствие', 'fa-heart-pulse', `${wb}%`]);
        cards.push(['Связь', 'fa-link', s.bonded ? 'есть метка' : 'нет метки']);
        return `<div class="ova-cards">${cards
            .map(([t, ic, v]) => `<div class="ova-info"><div class="ova-info-ic"><i class="fa-solid ${ic}"></i></div><div class="ova-info-t">${t}</div><div class="ova-info-v">${v}</div></div>`)
            .join('')}</div>`;
    }

    function tipsFor(who) {
        const s = S();
        const st = ST();
        const p = s[who];
        const info = api.phaseInfo(s, st, who);
        const shown = api.visiblePreg(st, who);
        const om = p.gender === 'omega';

        if (shown) {
            const t = [
                ['Питание', 'Небольшие частые приёмы пищи и достаточно воды.'],
                ['Отдых', 'Больше сна и меньше стресса: самочувствие зависит от покоя.'],
                ['Рядом с парой', 'Запах близкого альфы успокаивает и снижает тревогу.'],
            ];
            if (p.sex === 'male') t.push(['Кесарево', 'Роды путём кесарева сечения — стоит подготовиться заранее.']);
            return t;
        }
        if (info.phase === 'none') {
            return [
                ['Баланс', 'У бет нейтральный фон — вы помогаете остальным сохранять спокойствие.'],
                ['Нейтральный запах', 'Ваш запах может приглушать феромоны альф и омег рядом.'],
            ];
        }
        if (info.phase === 'active') {
            return om
                ? [
                    ['Береги силы', 'Во время течки организму нужны вода, отдых и покой.'],
                    ['Гнездо', 'Мягкие вещи с запахом близкого человека успокаивают.'],
                    ['Безопасность', 'Будь рядом с тем, кому доверяешь: феромоны притягивают альф.'],
                ]
                : [
                    ['Держи себя в руках', 'Гон усиливает агрессию и собственнические инстинкты.'],
                    ['Силы', 'Больше белка и воды: тело тратит много энергии.'],
                    ['Пространство', 'Если накрывает — лучше отойти и остыть.'],
                ];
        }
        if (info.phase === 'pre') {
            return [
                ['Предвестники', om ? 'Беспокойство и острый нюх — признаки скорой течки.' : 'Раздражительность и обострённые инстинкты — признаки скорого гона.'],
                ['Подготовься', 'Вода, перекус и безопасное место — заранее.'],
            ];
        }
        if (info.phase === 'fade') {
            return [
                ['Восстановление', 'Организм приходит в норму: больше сна и мягкой еды.'],
                ['Нежность', 'Чувствительность ещё повышена — близость лучше без спешки.'],
            ];
        }
        return [
            ['Спокойные дни', 'Организм восстановился — хорошее время для дел и прогулок.'],
            ['Запах и эмоции', 'Феромоны выдают настроение — прислушивайся к себе и к паре.'],
        ];
    }

    function tipsHtml(who) {
        return `<div class="ova-h">Советы на каждый день</div>
        <div class="ova-tips">${tipsFor(who)
            .map(([t, tx]) => `<div class="ova-tip"><b>${t}</b><p>${tx}</p></div>`)
            .join('')}</div>`;
    }

    // -----------------------------------------------------------------------
    // Экраны
    // -----------------------------------------------------------------------

    function headerHtml() {
        const today = Math.floor(ST().totalDays);
        const h = new Date().getHours();
        const hello = h < 5 ? 'Доброй ночи,' : h < 12 ? 'Доброе утро,' : h < 18 ? 'Добрый день,' : 'Добрый вечер,';
        const initial = esc((api.names().user || '?').charAt(0).toUpperCase());
        return `
        <div class="ova-head">
            <div>
                <div class="ova-hello">${hello}</div>
                <div class="ova-name">${esc(api.names().user)}</div>
                <div class="ova-date">День ${today + 1}</div>
            </div>
            <button class="ova-avatar" data-act="tab" data-tab="profile">${initial}</button>
        </div>`;
    }

    function rowHtml(label, value) {
        return `<div class="ova-row"><span>${label}</span><b>${value}</b></div>`;
    }

    function barHtml(pct, cls) {
        return `<div class="ova-bar ${cls}"><div style="width:${Math.max(0, Math.min(100, pct))}%"></div></div>`;
    }

    // Беременность: подтверждена — полная картина; не подтверждена, но есть симптомы — намёк без спойлеров
    function pregPanelHtml(who) {
        const s = S();
        const st = ST();
        const term = clampInt(s.termWeeks, 4, 60, 40);
        const preg = st[who].preg;
        if (!preg) return '';
        const shown = api.visiblePreg(st, who);
        if (!shown) {
            const f = preg.flags || {};
            if (!(f.mood || f.cycle || f.sick)) return '';
            return `<div class="ova-pad"><div class="ova-status ova-preg-card warn">
                <div class="ova-preg-h"><i class="fa-solid fa-triangle-exclamation"></i> Необычные симптомы</div>
                <p class="ova-muted">Организм ведёт себя непривычно, причина пока неясна. Подтверждение или объяснение придёт позже.</p>
            </div></div>`;
        }
        const elapsed = Math.max(0, st.totalDays - preg.startDay);
        const w = api.pregWeek(st, who);
        const tri = w < 13 ? 1 : (w < 27 ? 2 : 3);
        const stage = [
            'Первый триместр: возможны слабость, тошнота и перепады настроения. Организм перестраивается.',
            'Второй триместр: самочувствие обычно выравнивается, живот становится заметным.',
            'Третий триместр: усталость, тяжесть, подготовка к родам. Нужен покой и близкий человек рядом.',
        ][tri - 1];
        const left = Math.max(0, Math.ceil(term * 7 - elapsed));
        const conceived = Math.floor(preg.startDay) + 1;
        const due = Math.floor(preg.startDay + term * 7) + 1;
        const conf = preg.confirmedDay != null ? preg.confirmedDay + 1 : null;
        const wb = clampInt(preg.wellbeing, 0, 100, 100);
        const name = esc(api.names()[who]);
        let h = `<div class="ova-preg-h"><i class="fa-solid fa-person-pregnant"></i> Беременность подтверждена</div>
            <p class="ova-muted">${name}: ${esc(stage)}</p>`;
        h += rowHtml('Срок', `неделя ${w} из ${term} · ${tri} триместр`);
        h += barHtml((elapsed / (term * 7)) * 100, 'wb');
        h += rowHtml('Зачатие', `день ${conceived}`);
        if (conf != null) h += rowHtml('Подтверждена', `день ${conf}`);
        h += rowHtml('Роды ожидаются', left > 0 ? `день ${due} (через ~${left} дн.)` : '<b>срок наступил</b>');
        h += rowHtml('Самочувствие', `${wb}%`);
        if (S()[who].sex === 'male') h += rowHtml('Роды', 'кесарево сечение');
        return `<div class="ova-pad"><div class="ova-status ova-preg-card">${h}</div></div>`;
    }

    function logHtml(who) {
        const log = (ST()[who].log || []).slice(-12).reverse();
        if (!log.length) return '';
        return `<div class="ova-pad"><div class="ova-h">Журнал</div><div class="ova-status">${log
            .map(e => rowHtml(`день ${e.day + 1}`, esc(e.text)))
            .join('')}</div></div>`;
    }

    // Сводка: то, что раньше показывал плавающий инфоблок
    function statusHtml(who) {
        const s = S();
        const st = ST();
        const p = s[who];
        const info = api.phaseInfo(s, st, who);
        const shown = api.visiblePreg(st, who);
        const preg = st[who].preg;
        const term = clampInt(s.termWeeks, 4, 60, 40);
        let h = '';

        if (info.phase === 'none') {
            h += rowHtml('Цикл', 'нет (бета)');
        } else {
            const synced = info.owner !== who ? ' (синхр.)' : '';
            const irr = api.isIrregular(s, info);
            const word = wordsFor(p.gender).nom;
            if (info.broken) {
                h += rowHtml('Цикл', 'сбит');
            } else if (irr) {
                h += rowHtml('Цикл', `нерегулярный${synced}`);
            } else {
                h += rowHtml('Цикл', `день ${info.day + 1}/${info.L}${synced}`);
                h += barHtml(((info.day + 1) / info.L) * 100, `ph-${info.phase}`);
            }
            h += rowHtml('Фаза', `<span class="ova-ph ph-${info.phase}">${esc(api.phaseLabel(p.gender, info.phase, info))}</span>`);
            if (!info.broken) {
                h += rowHtml(word, info.phase === 'active'
                    ? `идёт, ещё ${info.daysLeft} дн.`
                    : (irr ? 'непредсказуемо' : `через ${info.daysToActive} дн.`));
            }
            if (p.gender === 'omega' && !shown) {
                h += rowHtml('Фертильность', `~${api.conceptionChance(s, st, who, false, true)}%`);
            }
        }

        h += rowHtml('Настроение', esc(api.MOODS[api.effectiveMood(s, st, who)][0]));
        if ((p.scent || '').trim()) h += rowHtml('Запах', esc(p.scent.trim()));

        if (shown) {
            const wb = clampInt(shown.wellbeing, 0, 100, 100);
            h += rowHtml('Беременность', `неделя ${api.pregWeek(st, who)}/${term}`);
            h += rowHtml('Самочувствие', `${wb}%`);
            h += barHtml(wb, 'wb');
        } else {
            if (p.gender === 'omega') h += rowHtml('Беременность', (s.auto.enabled && s.auto.hiddenPreg) ? 'не подтверждена' : 'нет');
            if (preg && preg.flags && preg.flags.sick) {
                const wb = clampInt(preg.wellbeing, 0, 100, 100);
                h += rowHtml('Самочувствие', `${wb}%`);
                h += barHtml(wb, 'wb');
            }
        }
        if (s.bonded) h += rowHtml('Связь', 'есть метка');
        return `<div class="ova-status">${h}</div>`;
    }

    // Кнопки и настройки: начать/завершить течку или гон, настроение, беременность
    function controlsHtml(who) {
        const s = S();
        const st = ST();
        const p = s[who];
        const info = api.phaseInfo(s, st, who);
        const shown = api.visiblePreg(st, who);
        const W = wordsFor(p.gender);
        const btn = (act, label, extra = '') => `<button class="ova-btn${extra}" data-act="${act}" data-who="${who}">${label}</button>`;
        let h = '';

        if (info.phase !== 'none') {
            const active = info.phase === 'active';
            h += `<div class="ova-h">${W.nom}</div><div class="ova-btnrow">
                ${active ? btn('endActive', `Завершить ${W.acc}`, ' pink') : btn('startActive', `Начать ${W.acc}`, ' pink')}
                ${btn('suddenHeat', 'Внезапно (с уведомлением)')}
                ${btn('resetCycle', 'Сбросить цикл')}
            </div>`;
        }

        const cur = st[who].mood || 'auto';
        const chips = [`<button class="ova-mood${cur === 'auto' ? ' on' : ''}" data-act="mood" data-who="${who}" data-mood="auto">Авто</button>`]
            .concat(Object.entries(api.MOODS).map(([k, [ru]]) =>
                `<button class="ova-mood${cur === k ? ' on' : ''}" data-act="mood" data-who="${who}" data-mood="${k}">${ru}</button>`))
            .join('');
        h += `<div class="ova-h">Настроение</div><div class="ova-moods">${chips}</div>`;

        if (shown) {
            const wb = clampInt(shown.wellbeing, 0, 100, 100);
            h += `<div class="ova-wide"><div class="ova-wide-h"><span>Самочувствие</span><b>${wb}%</b></div>
                <input type="range" min="0" max="100" value="${wb}" data-wb="${who}" /></div>`;
        }

        if (p.gender === 'omega') {
            h += '<div class="ova-h">Беременность</div>';
            if (!shown) {
                h += `<label class="checkbox_label"><input type="checkbox" data-knot="${who}" ${api.knotFlags[who] ? 'checked' : ''} /><span>Узел (knotting)</span></label>`;
            }
            h += `<div class="ova-btnrow">
                ${shown ? btn('birth', 'Роды') : btn('conceive', 'Бросок зачатия') + btn('forcePreg', 'Беременность без броска')}
                ${btn('cancelPreg', 'Сбросить беременность')}
            </div>`;
        }
        return `<div class="ova-pad ova-controls">${h}</div>`;
    }

    function personScreen(who, headHtml) {
        const s = S();
        const st = ST();
        const p = s[who];
        const shown = api.visiblePreg(st, who);
        const m = api.effectiveMood(s, st, who);
        const fert = (p.gender === 'omega' && !shown)
            ? `<span class="ova-chip">Зачатие ~${api.conceptionChance(s, st, who, false, true)}%</span>`
            : '';
        const intimacy = who === 'user'
            ? `<div class="ova-acts"><button class="ova-act" data-act="sheet" data-sheet="intimacy"><span class="ova-circle white"><i class="fa-solid fa-heart"></i></span><b>Близость</b></button></div>`
            : '';

        return `
        ${headHtml}
        ${heroHtml(who)}
        <div class="ova-chips">${fert}<span class="ova-chip">${esc(api.MOODS[m][0])}</span></div>
        ${intimacy}
        ${pregPanelHtml(who)}
        <div class="ova-pad">
            ${statusHtml(who)}
        </div>
        ${logHtml(who)}
        ${controlsHtml(who)}
        <div class="ova-pad">
            ${tipsHtml(who)}
            <div class="ova-h">Сегодня</div>
            ${cardsHtml(who)}
        </div>`;
    }

    function todayScreen() {
        return personScreen('user', headerHtml());
    }

    function partnerScreen() {
        const p = S().char;
        const g = api.GENDERS[p.gender];
        const head = `
        <div class="ova-pad">
            <div class="ova-title">Партнёр</div>
            <div class="ova-prof">
                <div class="ova-avatar big">${esc((api.names().char || '?').charAt(0).toUpperCase())}</div>
                <div><div class="ova-prof-n">${esc(api.names().char)}</div>
                <div class="ova-prof-t">${g.sym} ${g.ru} · ${api.SEX[p.sex].sym} ${api.SEX[p.sex].ru}</div></div>
            </div>
        </div>`;
        return personScreen('char', head);
    }

    // ---- Профиль ----

    function personFields(who) {
        const F = api.Fields;
        return `
        ${F.sel(`${who}.sex`, 'Пол', [['male', 'Мужской ♂'], ['female', 'Женский ♀']])}
        ${F.sel(`${who}.gender`, 'Вторичный пол', [['alpha', 'Альфа α'], ['beta', 'Бета β'], ['omega', 'Омега Ω']])}
        ${F.txt(`${who}.scent`, 'Запах', who === 'user' ? 'напр.: мёд и тёплый дождь' : 'напр.: кедр и дым')}
        ${F.num(`${who}.cycleLength`, 'Длина цикла (дни)', 5, 400)}
        ${F.num(`${who}.preDays`, 'Предфаза (дни)', 0, 60)}
        ${F.num(`${who}.activeDays`, 'Течка/гон (дни)', 1, 60)}
        ${F.num(`${who}.fadeDays`, 'Затухание (дни)', 0, 60)}`;
    }

    function worldFields() {
        const F = api.Fields;
        return `
        ${F.chk('bonded', 'Пара связана меткой (bond)')}
        ${F.chk('syncBond', 'Синхронизировать течку и гон при связи')}
        ${F.num('activeFertility', 'Фертильность в течку (%)', 0, 100)}
        ${F.num('termWeeks', 'Срок беременности (недели)', 4, 60)}
        ${F.chk('clock.enabled', 'Время из инфоблока в чате')}
        ${F.chk('autoTick', 'Без инфоблока: время идёт само (с каждым ответом)')}
        ${F.num('daysPerMessage', 'Дней за сообщение (без инфоблока)', 0, 365, 0.1)}
        <div class="ova-wide">
            <div class="ova-wide-h"><span>День истории</span><b>${Math.floor(ST().totalDays) + 1}</b></div>
            ${api.clockLabel() ? `<div class="ova-wide-h"><span>Время в чате</span><b>${esc(api.clockLabel())}</b></div>` : ''}
            <div class="ova-btnrow">
                <button class="ova-btn" data-act="time" data-n="-1">−1 день</button>
                <button class="ova-btn" data-act="time" data-n="1">+1 день</button>
                <button class="ova-btn" data-act="time" data-n="7">+7 дней</button>
            </div>
        </div>`;
    }

    function iconFieldsHtml() {
        const s = S();
        const ic = s.icon;
        const rng = (path, label, min, max, step) => `<div class="ov-row"><label>${label}</label><input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${esc(api.getPath(s, path))}" /></div>`;
        const glyphNames = { 'Ω': 'Омега', 'α': 'Альфа', 'β': 'Бета', '☾': 'Луна', '✦': 'Звезда' };
        return `
        ${api.Fields.chk('icon.show', 'Показывать плавающий значок')}
        <div class="ov-row"><label>Цвет</label><input type="color" data-path="icon.color" value="${esc(ic.color)}" /></div>
        ${rng('icon.size', 'Размер', 32, 120, 1)}
        ${rng('icon.opacity', 'Прозрачность (видимость)', 0.15, 1, 0.05)}
        ${api.Fields.sel('icon.glyph', 'Символ', api.ICON_GLYPHS.map(g => [g, `${g} ${glyphNames[g] || ''}`.trim()]))}
        <div class="menu_button ova-btn" data-fab-reset>Вернуть значок в угол</div>`;
    }

    function section(id, title, inner) {
        const open = openSec === id;
        return `<div class="ova-sec${open ? ' open' : ''}">
            <div class="ova-sec-h" data-act="sec" data-sec="${id}"><span>${title}</span><i class="fa-solid fa-chevron-${open ? 'up' : 'down'}"></i></div>
            ${open ? `<div class="ova-sec-b">${inner}</div>` : ''}
        </div>`;
    }

    function profileScreen() {
        const s = S();
        const p = s.user;
        const g = api.GENDERS[p.gender];
        const initial = esc((api.names().user || '?').charAt(0).toUpperCase());
        return `
        <div class="ova-pad">
            <div class="ova-title">Профиль</div>
            <div class="ova-prof">
                <div class="ova-avatar big">${initial}</div>
                <div><div class="ova-prof-n">${esc(api.names().user)}</div>
                <div class="ova-prof-t">${g.sym} ${g.ru} · ${api.SEX[p.sex].sym} ${api.SEX[p.sex].ru}</div></div>
            </div>
            ${section('me', 'Моя анкета и цикл', personFields('user'))}
            ${section('partner', 'Анкета партнёра', personFields('char'))}
            ${section('auto', 'Авто-события', api.autoPanelHtml(true, false))}
            ${section('world', 'Мир, связь и время', worldFields())}
            ${section('icon', 'Плавающий значок', iconFieldsHtml())}
        </div>`;
    }

    // ---- Листы ----

    function pairOmega() {
        const s = S();
        if (s.user.gender === 'omega') return 'user';
        if (s.char.gender === 'omega') return 'char';
        return null;
    }

    function sheetHtml() {
        if (!sheet) return '';
        const s = S();
        const st = ST();
        let body = '';

        if (sheet === 'intimacy') {
            const om = pairOmega();
            if (!om) {
                body = `<div class="ova-sheet-t">Близость</div>
                <p class="ova-muted">В этой паре нет омеги, зачатие невозможно.</p>
                <button class="ova-btn wide" data-act="closeSheet">Закрыть</button>`;
            } else {
                const knot = !!api.knotFlags[om];
                const shown = api.visiblePreg(st, om);
                const chance = api.conceptionChance(s, st, om, knot, true);
                body = `<div class="ova-sheet-t">Близость</div>
                ${shown
                    ? '<p class="ova-muted">Беременность уже есть.</p>'
                    : `<label class="checkbox_label"><input type="checkbox" data-knot="${om}" ${knot ? 'checked' : ''} /><span>Узел (knotting)</span></label>
                       <p class="ova-muted">Шанс зачатия сейчас: ~${chance}%.${s.auto.enabled && s.auto.hiddenPreg ? ' Если зачатие произойдёт, ты узнаешь об этом не сразу.' : ''}</p>`}
                <div class="ova-btnrow">
                    ${shown ? '' : '<button class="ova-btn pink" data-act="intimacy">Отметить близость</button>'}
                    <button class="ova-btn" data-act="closeSheet">Закрыть</button>
                </div>`;
            }
        }
        return `<div class="ova-sheet-bg" data-act="bgClose"><div class="ova-sheet">${body}</div></div>`;
    }

    // -----------------------------------------------------------------------
    // Оболочка и рендер
    // -----------------------------------------------------------------------

    function screenHtml(which) {
        if (which === 'partner') return partnerScreen();
        if (which === 'profile') return profileScreen();
        return todayScreen();
    }

    function ensureRoot() {
        let $r = $('#ov_app');
        if ($r.length) return $r;

        $r = $(`
        <div id="ov_app" class="ova-backdrop" style="display:none">
            <div class="ova-phone">
                <div class="ova-statusbar"><span class="ova-logo">claws</span><button class="ova-x" data-act="close" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
                <div class="ova-screen"></div>
                <div class="ova-tabbar"></div>
                <div class="ova-sheet-wrap"></div>
            </div>
        </div>`);
        $('body').append($r);

        $r.on('click', function (e) {
            if (e.target === $r[0]) close();
        });

        $r.on('click', '[data-act]', function (e) {
            const $t = $(this);
            const act = $t.data('act');
            const who = $t.data('who');
            if (act === 'bgClose' && e.target !== this) return;

            switch (act) {
                case 'close': close(); return;
                case 'tab': tab = $t.data('tab'); sheet = null; render(true); return;
                case 'sheet': sheet = $t.data('sheet'); render(); return;
                case 'closeSheet':
                case 'bgClose': sheet = null; render(); return;
                case 'mood':
                    api.getState()[who || 'user'].mood = $t.data('mood');
                    api.saveState();
                    api.refreshAll();
                    return;
                case 'intimacy': {
                    const om = pairOmega();
                    if (om) api.doConceive(om, false);
                    sheet = null;
                    api.refreshAll();
                    return;
                }
                case 'time': api.shiftTime($t.data('n')); return;
                case 'sec': openSec = openSec === $t.data('sec') ? '' : $t.data('sec'); render(); return;
                case 'startActive': api.setCycleDay(who, 'active'); break;
                case 'endActive': api.setCycleDay(who, 'end'); break;
                case 'resetCycle': api.setCycleDay(who, 'start'); break;
                case 'suddenHeat': api.suddenHeat(who, true); break;
                case 'conceive': api.doConceive(who, false); break;
                case 'forcePreg': api.doConceive(who, true); break;
                case 'cancelPreg': api.cancelPreg(who); return;
                case 'birth': api.finishPregnancy(who); break;
                default: return;
            }
            api.refreshAll();
        });

        $r.on('click', '[data-fab-reset]', function () {
            S().icon.pos = null;
            api.saveSettingsDebounced();
            applyIcon();
        });

        $r.on('change', 'input[data-wb]', function () {
            const who = $(this).data('wb');
            const preg = api.getState()[who].preg;
            if (preg) preg.wellbeing = Number($(this).val());
            api.saveState();
            api.refreshAll();
        });

        $r.on('change', 'input[data-knot]', function () {
            api.knotFlags[$(this).data('knot')] = $(this).prop('checked');
        });

        return $r;
    }

    function render(resetScroll = false) {
        if (!isOpen) return;
        const ae = document.activeElement;
        if (tab === 'profile' && ae && $(ae).closest('#ov_app').length && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;

        const $r = ensureRoot();
        const $screen = $r.find('.ova-screen');
        const top = resetScroll ? 0 : $screen.scrollTop();
        $screen.html(screenHtml(tab));
        $screen.scrollTop(top);
        $r.find('.ova-tabbar').html(TABS.map(([id, icon, label]) =>
            `<button class="ova-tab${tab === id ? ' on' : ''}" data-act="tab" data-tab="${id}"><i class="fa-solid ${icon}"></i><span>${label}</span></button>`).join(''));
        $r.find('.ova-sheet-wrap').html(sheetHtml());
    }

    function open(which) {
        if (which) tab = which;
        isOpen = true;
        sheet = null;
        const $r = ensureRoot();
        $r.css('display', 'flex');
        render(true);
    }

    function close() {
        isOpen = false;
        $('#ov_app').css('display', 'none');
    }

    // -----------------------------------------------------------------------
    // Плавающий значок
    // -----------------------------------------------------------------------

    function createFab() {
        const $f = $('<div id="ov_fab" title="Omegaverse"><span class="ov-fab-glyph"></span><i class="ov-fab-dot"></i></div>');
        $('body').append($f);
        const el = $f[0];
        let drag = null;

        el.addEventListener('pointerdown', e => {
            const r = el.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, sx: e.clientX, sy: e.clientY, moved: false };
            try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        });
        el.addEventListener('pointermove', e => {
            if (!drag) return;
            if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 6) return;
            drag.moved = true;
            const size = el.offsetWidth;
            const x = Math.min(window.innerWidth - size, Math.max(0, e.clientX - drag.dx));
            const y = Math.min(window.innerHeight - size, Math.max(0, e.clientY - drag.dy));
            el.style.left = `${x}px`;
            el.style.top = `${y}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        });
        el.addEventListener('pointerup', () => {
            if (!drag) return;
            const d = drag;
            drag = null;
            if (d.moved) {
                const r = el.getBoundingClientRect();
                S().icon.pos = { x: r.left, y: r.top };
                api.saveSettingsDebounced();
            } else {
                open();
            }
        });
        el.addEventListener('pointercancel', () => { drag = null; });
        return $f;
    }

    function applyIcon() {
        const s = S();
        const ic = s.icon;
        let $f = $('#ov_fab');
        if (!s.enabled || !ic.show) {
            $f.hide();
            return;
        }
        if (!$f.length) $f = createFab();

        const num = (v, min, max, def) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
        };
        const size = num(ic.size, 32, 120, 52);
        const op = num(ic.opacity, 0.15, 1, 0.92);
        const col = (ic.color && ic.color.toLowerCase() !== '#c2a15f') ? ic.color : 'var(--ov-brass)';

        $f.show().css({ width: size, height: size, color: col, borderColor: col, opacity: op, fontSize: Math.round(size * 0.5) });
        $f.find('.ov-fab-glyph').text(api.ICON_GLYPHS.includes(ic.glyph) ? ic.glyph : api.ICON_GLYPHS[0]);

        const vw = window.innerWidth || document.documentElement.clientWidth || 360;
        const vh = window.innerHeight || document.documentElement.clientHeight || 640;
        let x;
        let y;
        if (ic.pos && Number.isFinite(ic.pos.x) && Number.isFinite(ic.pos.y)) {
            x = ic.pos.x;
            y = ic.pos.y;
        } else {
            x = vw - size - 14;
            y = vh - size - 120;
        }
        x = Math.min(vw - size, Math.max(0, x));
        y = Math.min(vh - size, Math.max(0, y));
        $f.css({ left: x, top: y, right: 'auto', bottom: 'auto' });

        const info = api.phaseInfo(s, ST(), 'user');
        $f.toggleClass('ov-fab-alert', info.phase === 'active' && !info.broken);
    }

    window.addEventListener('resize', () => applyIcon());
    window.addEventListener('orientationchange', () => setTimeout(applyIcon, 300));

    function refresh() {
        if (!S().enabled && isOpen) close();
        applyIcon();
        render();
    }

    return { open, close, refresh, applyIcon, iconFieldsHtml, screenHtml };
}
