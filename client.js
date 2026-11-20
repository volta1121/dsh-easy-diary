/**
 * dsh-diary —— DSH 设置页的客户端半边。
 *
 * 数据全部来自宿主半边的 /diary-api/*（GET）与 /diary-api-write/*（POST），
 * 浏览器不解 zstd、不读磁盘。
 * 注册两处：
 *   settings.section       —— 设置 → 日记（order 25）
 *   settings.section.icon  —— 同 id 的侧栏图标
 *
 * 双语：跟随 DSH 的 locale 服务，导航标题用 thunk 注册，切语言自动重取。
 */
window.__ModuleLoader__.load({
  id: 'dsh-diary',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const STR = {
      zh: {
        nav: '日记',
        title: '日记',
        hintAuto: '每天 {at} 自动写 · {dir}',
        loading: '读取中…',
        refresh: '刷新',
        refreshing: '读取中',
        legacy: '旧版控制页',
        errRead: '读取失败：{e}',
        running: '正在写日记…',
        empty: '还没有配置任何会话；到旧版控制页里添加。',
        on: '已启用',
        off: '已停用',
        done: '今天已写',
        notDone: '今天还没写',
        chars: '{n} 字',
        every: '每 {n} 天换新会话',
        resetAlways: '写完清上下文',
        book: '本子 {name}',
        writeToday: '现在写今天',
        writing: '写入中…',
        writeAt: '补写这天',
        pickDay: '先选一个日期',
        archive: '归档注入新对话',
        archiving: '归档中…',
        archConfirm: '确定归档',
        cancel: '取消',
        archWarn: '归档会先停掉当前对话、换个新会话；再点一次「确定归档」执行，或点「取消」。',
        archDone: '已归档并换到 {id}',
        archFail: '没换成新会话，看 dsh-diary.log',
        enabled: '写日记',
        search: '可查旧日记',
        recapPre: '新对话注入',
        recapPost: '天',
        everyPre: '每',
        everyPost: '天归档',
        atPre: '每天',
        atPost: '写',
        atBad: '时间要写成 HH:MM',
        view: '看日记',
        viewEmpty: '（这本还没有日记）',
        prompt: '提示词',
        promptHint: '下面是实际会发出去的完整提示词（含固定前缀）。保存后立刻生效；重置则回到默认那一串。',
        promptSave: '保存提示词',
        promptReset: '重置提示词',
        promptSaved: '提示词已保存',
        promptResetDone: '已恢复默认提示词',
        remove: '移除会话',
        removeWarn: '移除只是把这个会话从写日记列表里拿掉，不删会话、也不删日记本。再点一次「确定移除」执行。',
        removeConfirm: '确定移除会话',
        removeDone: '已移除',
        add: '添加会话',
        addTitle: '添加会话',
        addSearch: '搜索标题 / 目录 / id',
        addJoin: '加入',
        addNone: '没有匹配的会话',
        addDone: '已加入',
        addLoading: '加载会话列表…',
        close: '收起',
        saved: '已保存',
        wrote: '已写 {day}（{n} 字符）',
        failed: '没写成',
        failPrefix: '没写成：',
      },
      en: {
        nav: 'Diary',
        title: 'Diary',
        hintAuto: 'writes daily at {at} · {dir}',
        loading: 'Loading…',
        refresh: 'Refresh',
        refreshing: 'Loading',
        legacy: 'Classic page',
        errRead: 'Failed to load: {e}',
        running: 'Writing…',
        empty: 'No sessions configured yet — add one on the classic page.',
        on: 'Enabled',
        off: 'Disabled',
        done: 'Written today',
        notDone: 'Not written today',
        chars: '{n} chars',
        every: 'New session every {n}d',
        resetAlways: 'Clear context after write',
        book: 'Book {name}',
        writeToday: 'Write today now',
        writing: 'Writing…',
        writeAt: 'Write this day',
        pickDay: 'Pick a date first',
        archive: 'Archive + new session',
        archiving: 'Archiving…',
        archConfirm: 'Confirm archive',
        cancel: 'Cancel',
        archWarn: 'Archiving stops the current conversation and opens a new one. Click “Confirm archive” again to proceed, or cancel.',
        archDone: 'Archived; now on {id}',
        archFail: 'No new session was created — see dsh-diary.log',
        enabled: 'Write diary',
        search: 'Search old entries',
        recapPre: 'Inject into new sessions',
        recapPost: 'days',
        everyPre: 'Every',
        everyPost: 'days, archive',
        atPre: 'Daily at',
        atPost: '',
        atBad: 'Use HH:MM',
        view: 'Read diary',
        viewEmpty: '(no entries yet)',
        prompt: 'Prompt',
        promptHint: 'This is the full prompt actually sent (including the fixed prefix). Saving takes effect immediately; reset restores the default.',
        promptSave: 'Save prompt',
        promptReset: 'Reset prompt',
        promptSaved: 'Prompt saved',
        promptResetDone: 'Default prompt restored',
        remove: 'Remove session',
        removeWarn: 'Removing only drops this session from the diary list — the session and its file stay. Click “Confirm remove” again to proceed.',
        removeConfirm: 'Confirm remove session',
        removeDone: 'Removed',
        add: 'Add session',
        addTitle: 'Add session',
        addSearch: 'Filter by title / cwd / id',
        addJoin: 'Add',
        addNone: 'No matching sessions',
        addDone: 'Added',
        addLoading: 'Loading sessions…',
        close: 'Close',
        saved: 'Saved',
        wrote: 'Wrote {day} ({n} chars)',
        failed: 'Write failed',
        failPrefix: 'Write failed: ',
      },
    };

    let lang = 'zh';
    const listeners = new Set();
    const setLang = (v) => {
      if (v !== 'zh' && v !== 'en') return;
      if (v === lang) return;
      lang = v;
      for (const fn of listeners) fn();
    };

    function readLang(ctx) {
      try {
        const loc = ctx.get && ctx.get('locale');
        const snap = loc && typeof loc.getLocale === 'function' ? loc.getLocale() : null;
        const active = snap && snap.active ? String(snap.active) : '';
        return /^zh/i.test(active) ? 'zh' : active ? 'en' : 'zh';
      } catch {
        return 'zh';
      }
    }

    function useLang() {
      const [, force] = useState(0);
      useEffect(() => {
        const fn = () => force((n) => n + 1);
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      }, []);
      return lang;
    }

    function translator(l) {
      const dict = STR[l] || STR.zh;
      return (key, vars) => {
        let out = dict[key] || STR.zh[key] || key;
        if (vars) for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
        return out;
      };
    }

    const text = (v) => (v === undefined || v === null ? '' : String(v));
    const shortId = (id) => (typeof id === 'string' && id.length > 20 ? id.slice(0, 12) + '…' : text(id));

    function formatDay(day) {
      return /^\d{4}-\d{2}-\d{2}$/.test(text(day)) ? day.slice(5) : text(day);
    }

    async function post(path, body) {
      // 写操作走 host 的 handler 路由（resource 路由只接 GET/HEAD）；
      // 自定义头既是口令，也让跨站请求必须过 CORS 预检——过不来。
      const r = await fetch('/diary-api-write' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-diary-write': '1' },
        body: JSON.stringify(body || {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      return data;
    }

    function Check(props) {
      return h(
        'label',
        { className: 'dd-toggle' + (props.disabled ? ' off' : '') },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: (e) => props.onChange(e.target.checked),
        }),
        h('span', null, props.children),
      );
    }

    function Card(props) {
      const { s, today, onWrite, onArchive, onPatch, onDone } = props;
      const l = useLang();
      const t = translator(l);
      const [busy, setBusy] = useState('');
      const [msg, setMsg] = useState(null);
      const [day, setDay] = useState('');
      const [confirming, setConfirming] = useState(false);
      const [removing, setRemoving] = useState(false);
      const [viewing, setViewing] = useState(false);
      const [diaryText, setDiaryText] = useState('');
      const [reading, setReading] = useState(false);
      const [editing, setEditing] = useState(false);
      const [draft, setDraft] = useState('');

      const last = s.last && typeof s.last === 'object' ? s.last : null;
      const doneToday = s.todayWritten === true;
      const enabled = s.enabled !== false;

      const run = async (kind, fn) => {
        setBusy(kind);
        setMsg(null);
        try {
          const r = await fn();
          if (r) setMsg(r);
        } catch (e) {
          setMsg({ ok: false, text: String((e && e.message) || e) });
        } finally {
          setBusy('');
        }
      };

      const writeToday = () =>
        run('write', async () => {
          const r = await post('/write', { sessionId: s.id });
          const one = (r.results || [])[0] || {};
          if (one.ok) {
            onDone();
            return { ok: true, text: t('wrote', { day: text(r.day || today), n: text(one.chars || 0) }) };
          }
          return { ok: false, text: t('failPrefix') + (text(one.error) || t('failed')) };
        });

      const writeAt = () =>
        run('at', async () => {
          if (!day) return { ok: false, text: t('pickDay') };
          const r = await post('/write', { sessionId: s.id, date: day });
          const one = (r.results || [])[0] || {};
          if (one.ok) {
            onDone();
            return { ok: true, text: t('wrote', { day: text(r.day), n: text(one.chars || 0) }) };
          }
          return { ok: false, text: t('failPrefix') + (text(one.error) || t('failed')) };
        });

      const archive = () => {
        if (!confirming) {
          setConfirming(true);
          setMsg({ ok: false, text: t('archWarn') });
          return;
        }
        setConfirming(false);
        run('archive', async () => {
          const r = await post('/reset', { sessionId: s.id });
          onDone();
          return { ok: true, text: r.archivedOk ? t('archDone', { id: shortId(r.newId) }) : t('archFail') };
        });
      };

      const patch = (diff) =>
        run('patch', async () => {
          await post('/config', { sessions: [{ id: s.id, ...diff }] });
          onDone();
          return { ok: true, text: t('saved') };
        });

      // 看日记：/read 回的是 file 头 + 全文，text/plain，不是 JSON
      const toggleView = async () => {
        if (viewing) {
          setViewing(false);
          return;
        }
        setViewing(true);
        setReading(true);
        try {
          const r = await fetch('/diary-api/read?session=' + encodeURIComponent(s.id), { headers: { accept: 'text/plain' } });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          setDiaryText(await r.text());
        } catch (e) {
          setDiaryText(t('errRead', { e: String((e && e.message) || e) }));
        } finally {
          setReading(false);
        }
      };

      const togglePrompt = () => {
        if (editing) {
          setEditing(false);
          return;
        }
        setDraft(text(s.promptText));
        setEditing(true);
      };

      const savePrompt = () =>
        run('prompt', async () => {
          await post('/config', { sessions: [{ id: s.id, promptFull: draft }] });
          setEditing(false);
          onDone();
          return { ok: true, text: t('promptSaved') };
        });

      const resetPrompt = () =>
        run('prompt', async () => {
          await post('/config', { sessions: [{ id: s.id, promptFull: '', prompt: '' }] });
          setEditing(false);
          onDone();
          return { ok: true, text: t('promptResetDone') };
        });

      const remove = () => {
        if (!removing) {
          setRemoving(true);
          setMsg({ ok: false, text: t('removeWarn') });
          return;
        }
        setRemoving(false);
        run('remove', async () => {
          await post('/config', { remove: [s.id] });
          onDone();
          return { ok: true, text: t('removeDone') };
        });
      };

      return h(
        'div',
        { className: 'dd-card' },
        h(
          'div',
          { className: 'dd-card-head' },
          h('span', { className: 'dd-title' }, text(s.label) || shortId(s.id)),
          h('span', { className: 'dd-sub' }, t('book', { name: text(s.file || shortId(s.bookId || s.id)) })),
        ),
        h(
          'div',
          { className: 'dd-chips' },
          h('span', { key: 'e', className: 'dd-chip' + (enabled ? '' : ' off') }, enabled ? t('on') : t('off')),
          h('span', { key: 't', className: 'dd-chip' + (doneToday ? ' ok' : '') }, doneToday ? t('done') : t('notDone')),
          last && last.day === today ? h('span', { key: 'c', className: 'dd-chip' }, t('chars', { n: text(last.chars) })) : null,
          s.resetEvery ? h('span', { key: 'r', className: 'dd-chip' }, t('every', { n: text(s.resetEveryDays || 3) })) : null,
          s.reset === true ? h('span', { key: 'rs', className: 'dd-chip' }, t('resetAlways')) : null,
        ),
        h(
          'div',
          { className: 'dd-acts' },
          h('button', { className: 'dd-btn', onClick: writeToday, disabled: !!busy || !enabled }, busy === 'write' ? t('writing') : t('writeToday')),
          h('input', { className: 'dd-date', type: 'date', value: day, onChange: (e) => setDay(e.target.value) }),
          h('button', { className: 'dd-btn', onClick: writeAt, disabled: !!busy || !day }, busy === 'at' ? t('writing') : t('writeAt')),
          h(
            'button',
            { className: 'dd-btn' + (confirming ? ' danger' : ''), onClick: archive, disabled: !!busy },
            busy === 'archive' ? t('archiving') : confirming ? t('archConfirm') : t('archive'),
          ),
          confirming
            ? h('button', { className: 'dd-btn', onClick: () => { setConfirming(false); setMsg(null); } }, t('cancel'))
            : null,
        ),
        h(
          'div',
          { className: 'dd-acts' },
          h('button', { className: 'dd-btn' + (viewing ? ' on' : ''), onClick: toggleView, disabled: !!busy }, viewing ? t('close') : t('view')),
          h('button', { className: 'dd-btn' + (editing ? ' on' : ''), onClick: togglePrompt, disabled: !!busy }, editing ? t('close') : t('prompt')),
          h('button', { className: 'dd-btn danger' + (removing ? ' on' : ''), onClick: remove, disabled: !!busy }, removing ? t('removeConfirm') : t('remove')),
          removing ? h('button', { className: 'dd-btn', onClick: () => { setRemoving(false); setMsg(null); } }, t('cancel')) : null,
        ),
        viewing ? h('pre', { className: 'dd-pre' }, reading ? t('refreshing') : diaryText || t('viewEmpty')) : null,
        editing
          ? h(
              'div',
              { className: 'dd-edit' },
              h('p', { className: 'dd-hint' }, t('promptHint')),
              h('textarea', { className: 'dd-ta', value: draft, spellCheck: false, onChange: (e) => setDraft(e.target.value) }),
              h(
                'div',
                { className: 'dd-acts' },
                h('button', { className: 'dd-btn', onClick: savePrompt, disabled: !!busy }, t('promptSave')),
                h('button', { className: 'dd-btn', onClick: resetPrompt, disabled: !!busy }, t('promptReset')),
                h('button', { className: 'dd-btn', onClick: () => { setEditing(false); setMsg(null); } }, t('cancel')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'dd-opts' },
          h(Check, { checked: enabled, disabled: !!busy, onChange: (v) => patch({ enabled: v }) }, t('enabled')),
          h(Check, { checked: s.search !== false, disabled: !!busy, onChange: (v) => patch({ search: v }) }, t('search')),
          h(
            'label',
            { className: 'dd-toggle' },
            h('span', null, t('recapPre')),
            h('input', {
              className: 'dd-num',
              type: 'number',
              min: 0,
              max: 30,
              value: text(s.recapDays == null ? 3 : s.recapDays),
              disabled: !!busy,
              onChange: (e) => patch({ recapDays: Number(e.target.value) }),
              style: { width: 56, margin: '0 6px' },
            }),
            h('span', null, t('recapPost')),
          ),
          h(
            'label',
            { className: 'dd-toggle' + (busy ? ' off' : '') },
            h('input', {
              type: 'checkbox',
              checked: s.resetEvery === true,
              disabled: !!busy,
              onChange: (e) => patch({ resetEvery: e.target.checked, resetEveryDays: Number(s.resetEveryDays || 3) }),
            }),
            h('span', null, t('everyPre')),
            h('input', {
              className: 'dd-num',
              type: 'number',
              min: 1,
              max: 365,
              value: text(s.resetEveryDays || 3),
              disabled: !!busy || s.resetEvery !== true,
              onChange: (e) => patch({ resetEveryDays: Number(e.target.value), resetEvery: true }),
              style: { width: 56, margin: '0 6px' },
            }),
            h('span', null, t('everyPost')),
          ),
        ),
        msg ? h('p', { className: 'dd-msg' + (msg.ok ? '' : ' err') }, msg.text) : null,
      );
    }

    function DiaryPage() {
      const l = useLang();
      const t = translator(l);
      const [state, setState] = useState({ status: 'loading', data: null, error: null });
      const [atDraft, setAtDraft] = useState('');
      const [atBusy, setAtBusy] = useState(false);
      const [adding, setAdding] = useState(false);
      const [cands, setCands] = useState(null);
      const [q, setQ] = useState('');
      const [joinBusy, setJoinBusy] = useState('');

      const load = () => {
        setState((prev) => ({ ...prev, status: prev.data ? 'refreshing' : 'loading' }));
        fetch('/diary-api/state', { headers: { accept: 'application/json' } })
          .then((r) => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          })
          .then((data) => setState({ status: 'ready', data, error: null }))
          .catch((e) => setState((prev) => ({ ...prev, status: 'error', error: String((e && e.message) || e) })));
      };

      useEffect(() => {
        load();
      }, []);

      const data = state.data;
      const sessions = (data && data.sessions) || [];
      const today = (data && data.today) || '';

      useEffect(() => {
        const at = data && data.at ? String(data.at) : '';
        setAtDraft(/^\d{1,2}:\d{2}$/.test(at) ? (at.length === 4 ? '0' + at : at) : at);
      }, [data && data.at]);

      const saveAt = async () => {
        if (!/^\d{1,2}:\d{2}$/.test(atDraft)) return;
        setAtBusy(true);
        try {
          await post('/config', { at: atDraft });
          load();
        } catch {
          /* 下一轮刷新会显示真实状态 */
        } finally {
          setAtBusy(false);
        }
      };

      const toggleAdd = async () => {
        if (adding) {
          setAdding(false);
          return;
        }
        setAdding(true);
        if (cands) return;
        try {
          const r = await fetch('/diary-api/sessions', { headers: { accept: 'application/json' } });
          const j = await r.json();
          setCands(Array.isArray(j.items) ? j.items : []);
        } catch {
          setCands([]);
        }
      };

      const join = async (it) => {
        setJoinBusy(it.id);
        try {
          await post('/config', { add: [{ id: it.id, label: it.title || it.id, bookId: it.id, cwd: it.cwd || '' }] });
          load();
        } catch {
          /* 失败时按钮恢复，用户可再点 */
        } finally {
          setJoinBusy('');
        }
      };

      const have = new Set(sessions.map((x) => text(x.id)));
      const needle = q.trim().toLowerCase();
      const list = (cands || [])
        .filter((it) => !have.has(text(it.id)))
        .filter((it) => !needle || (text(it.title) + ' ' + text(it.cwd) + ' ' + text(it.id)).toLowerCase().includes(needle))
        .slice(0, 25);

      return h(
        'div',
        { className: 'dd-root' },
        h(
          'div',
          { className: 'dd-head' },
          h('h2', { className: 'dd-h2' }, t('title')),
          h(
            'div',
            { className: 'dd-tools' },
            h(
              'label',
              { className: 'dd-toggle', title: t('atBad') },
              h('span', null, t('atPre')),
              h('input', {
                className: 'dd-num dd-time',
                type: 'time',
                value: atDraft,
                disabled: atBusy,
                onChange: (e) => setAtDraft(e.target.value),
                onBlur: saveAt,
                onKeyDown: (e) => {
                  if (e.key === 'Enter') saveAt();
                },
              }),
              h('span', null, t('atPost')),
            ),
            h('span', { className: 'dd-hint' }, data ? text(data.diaryDir) : t('loading')),
            h('button', { className: 'dd-btn', onClick: toggleAdd, disabled: !data || state.status === 'loading' }, adding ? t('close') : t('add')),
            h('button', { className: 'dd-btn', onClick: load, disabled: state.status === 'loading' }, state.status === 'loading' ? t('refreshing') : t('refresh')),
            h('a', { className: 'dd-link', href: text((data && data.legacyUrl) || '/diary-api/ui'), target: '_blank', rel: 'noreferrer' }, t('legacy')),
          ),
        ),
        state.error ? h('p', { className: 'dd-error' }, t('errRead', { e: state.error })) : null,
        adding
          ? h(
              'div',
              { className: 'dd-add' },
              h('input', {
                className: 'dd-num dd-search',
                placeholder: t('addSearch'),
                value: q,
                onChange: (e) => setQ(e.target.value),
              }),
              cands === null
                ? h('p', { className: 'dd-hint' }, t('addLoading'))
                : list.length === 0
                  ? h('p', { className: 'dd-hint' }, t('addNone'))
                  : h(
                      'div',
                      { className: 'dd-list' },
                      list.map((it) =>
                        h(
                          'div',
                          { key: text(it.id), className: 'dd-item' },
                          h(
                            'div',
                            { className: 'dd-item-main' },
                            h('span', { className: 'dd-title' }, text(it.title) || shortId(it.id)),
                            h('span', { className: 'dd-sub' }, (text(it.cwd) || '—') + ' · ' + shortId(it.id)),
                          ),
                          h('button', { className: 'dd-btn', onClick: () => join(it), disabled: !!joinBusy && joinBusy !== it.id }, joinBusy === it.id ? '…' : t('addJoin')),
                        ),
                      ),
                    ),
            )
          : null,
        data && data.running ? h('p', { className: 'dd-hint' }, t('running')) : null,
        sessions.length === 0
          ? h('p', { className: 'dd-empty' }, data ? t('empty') : '…')
          : sessions.map((s) => h(Card, { key: text(s.id) || text(s.label), s, today, onDone: load })),
      );
    }

    function DiaryIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3.2 2.6h7.1a1.6 1.6 0 0 1 1.6 1.6v8.2H4.8a1.6 1.6 0 0 1-1.6-1.6z' }),
        h('path', { d: 'M3.2 10.4h8.7' }),
        h('path', { d: 'M5.6 5.2h3.6M5.6 7.2h2.6' }),
      );
    }

    const CSS = `
.dd-root{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px}
.dd-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:10px}
.dd-h2{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-text-primary,#e8e8ea)}
.dd-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dd-hint{margin:0;font-size:12px;color:var(--dsw-alias-text-tertiary,#9a9aa2)}
.dd-btn{cursor:pointer;font-size:12px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.16));background:transparent;color:inherit}
.dd-btn:disabled{opacity:.5;cursor:default}
.dd-btn.danger{border-color:var(--dsw-alias-state-error,#ff6b6b);color:var(--dsw-alias-state-error,#ff6b6b)}
.dd-link{font-size:12px;color:var(--dsw-alias-state-business-primary,#7aa2ff);text-decoration:none}
.dd-card{border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.12));border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-elevated,rgba(255,255,255,.02))}
.dd-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}
.dd-title{font-size:14px;font-weight:600}
.dd-sub{font-size:12px;color:var(--dsw-alias-text-tertiary,#9a9aa2)}
.dd-chips{display:flex;gap:6px;flex-wrap:wrap}
.dd-chip{font-size:11px;line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.16));color:var(--dsw-alias-text-secondary,#c2c2c8)}
.dd-chip.ok{border-color:var(--dsw-alias-state-success,#4bbf7a);color:var(--dsw-alias-state-success,#4bbf7a)}
.dd-chip.off{opacity:.6}
.dd-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dd-opts{display:flex;align-items:center;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-text-secondary,#c2c2c8)}
.dd-toggle{display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.dd-toggle.off{opacity:.55;cursor:default}
.dd-toggle input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary,#7aa2ff)}
.dd-date,.dd-num{font:inherit;font-size:12px;padding:3px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.16));background:transparent;color:inherit}
.dd-msg{margin:0;font-size:12px;color:var(--dsw-alias-text-secondary,#c2c2c8)}
.dd-msg.err{color:var(--dsw-alias-state-error,#ff6b6b)}
.dd-error{margin:0;font-size:12px;color:var(--dsw-alias-state-error,#ff6b6b)}
.dd-empty{margin:0;font-size:12px;color:var(--dsw-alias-text-tertiary,#9a9aa2)}
.dd-btn.on{border-color:var(--dsw-alias-state-business-primary,#7aa2ff);color:var(--dsw-alias-state-business-primary,#7aa2ff)}
.dd-pre{margin:0;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.7;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.12));background:var(--dsw-alias-bg-base,rgba(0,0,0,.18));color:var(--dsw-alias-text-secondary,#c2c2c8)}
.dd-edit{display:flex;flex-direction:column;gap:8px}
.dd-ta{width:100%;min-height:200px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.7;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-default,rgba(255,255,255,.16));background:transparent;color:inherit}
.dd-add{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:10px;border:1px dashed var(--dsw-alias-border-default,rgba(255,255,255,.2))}
.dd-search{width:100%;box-sizing:border-box;padding:6px 8px}
.dd-list{display:flex;flex-direction:column;gap:6px;max-height:280px;overflow:auto}
.dd-item{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dd-item-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dd-item-main .dd-title{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-item-main .dd-sub{font-size:11px;color:var(--dsw-alias-text-tertiary,#9a9aa2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dd-time{min-width:96px}
`;

    let styleInstalled = false;
    function ensureStyle() {
      if (styleInstalled || typeof document === 'undefined') return;
      styleInstalled = true;
      const el = document.createElement('style');
      el.setAttribute('data-dsh-diary', '');
      el.textContent = CSS;
      document.head.appendChild(el);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ensureStyle();
        setLang(readLang(ctx));
        try {
          const loc = ctx.get && ctx.get('locale');
          if (loc && typeof loc.subscribe === 'function') {
            const off = loc.subscribe(() => setLang(readLang(ctx)));
            if (typeof ctx.effect === 'function') ctx.effect(() => off);
          }
        } catch {}
        if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
        ctx.slots.inject('settings.section.icon', () =>
          ctx.slots.register({ name: 'settings.section.icon', id: 'diary' }, DiaryIcon),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'diary', order: 25, label: () => translator(lang)('nav') }, DiaryPage),
        );
      },
    };
  },
});
