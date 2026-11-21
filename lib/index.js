import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-diary';
export const inject = ['agents', 'sessions', 'workspaceRegistry'];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const STATE_FILE = path.join(ROOT, 'state.json');

const DEFAULTS = {
  at: '22:00',                 // 每天几点写
  sessions: [],                // [{ id: 'session-...', label: '好友 私聊', enabled, reset, resetEvery, resetEveryDays, recapDays, search, prompt }]
  diaryDir: path.join(os.homedir(), '.dsh', 'diary'),
  maxWaitMs: 150 * 1000,      // 没有正文就停掉回合的最长等待时间
  port: 0,                     // 独立控制口（0 = 不开；优先挂 DSH 自己的 web 路由）
  token: '',                   // 空 = 首次启动自动生成
  catchUp: true,               // 启动时补写「上次打开 DSH 那天」
  prompt: '',                  // 全局日记提示词，空 = DEFAULT_PROMPT
  recapDays: 3,               // 新对话注入最近几篇日记
  retryMs: 5 * 60 * 1000,      // 一次没写成之后，隔多久再试
  holdFile: '',                // 写日记时给桥的占位文件（空 = 不通知桥）
  bridgeMapFile: '',           // 桥的会话映射文件（空 = 不跟随；相对路径按插件目录解析）
  bridgeMapUrl: '',            // 桥的会话映射 HTTP 接口（空 = 不用）
  bridgeMapCommand: '',        // 能打印会话映射 JSON 的命令（空 = 不用）
  bridgeMapCacheMs: 30000,     // 映射缓存多久（毫秒）
  ifArchived: 'auto',          // 目标会话已归档时：auto（有桥=临时取消归档写完还原）/ defer（跳过）/ unarchive（总是取消归档）
};

const DEFAULT_PROMPT =
  '写日记 ${day}。用第一人称写那天的事，3~8 句，口语、有具体细节。把日记正文放进 <diary> 和 </diary> 之间，标签外面什么都不要写：不要解释、不要英文说明、不要 Markdown、不要日期和标题、也不要问我。只用简体中文写散文（别写成繁体字）；不要输出摘要、条目列表、写作草稿、压缩记录（m01234–m01234 那种）或对任务的复述。';

// ---------------------------------------------------------------- 小工具

function dateKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 日期加减（'YYYY-MM-DD'，按本地日历）
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + Number(n || 0));
  return dateKey(d);
}

// 只收真实存在的 'YYYY-MM-DD'：'2026-02-31' 会被 Date 悄悄算成 3 月 3 日，
// 手写接口时容易把「## 2026-02-31 日记」这种标题永久写进日记文件。
function validDay(day) {
  const s = String(day || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const d = new Date(`${s}T00:00:00`);
  return Number.isNaN(d.getTime()) || dateKey(d) !== s ? '' : s;
}

// 「HH:MM」统一校验：越界（25:00、22:70）一律当无效，避免「校验通过、调度钳位、日界判断」三套值打架
function normalizeAt(at) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at == null ? '' : at).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi, text: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

function atToday(at) {
  const p = normalizeAt(at);
  const d = new Date();
  d.setHours(p ? p.h : 22, p ? p.m : 0, 0, 0);
  return d;
}

function nextAt(at) {
  const d = atToday(at);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d;
}

function safeName(id) {
  return String(id).replace(/[^\w.-]+/g, '_');
}

// create()/get() 的返回结构不稳定（可能是 {session:{...}} 或包装对象），递归找真正的 session id
function pickSessionId(x, depth = 0) {
  if (!x || depth > 3) return '';
  if (typeof x === 'string') return /^session-[0-9a-f-]{8,}$/i.test(x) ? x : '';
  if (typeof x !== 'object') return '';
  for (const k of ['id', 'sessionId', 'session_id']) {
    const v = x[k];
    if (typeof v === 'string' && /^session-/i.test(v)) return v;
  }
  for (const k of ['session', 'value', 'data', 'result']) {
    const r = pickSessionId(x[k], depth + 1);
    if (r) return r;
  }
  return '';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ── 桥的会话映射：任何形状都归一化成 { 'group:123': 'session-...' }
// 支持三种写法：
//   { sessions: { 'group:123': 'session-a' } }        （QQ 桥的 sessions.json）
//   { sessions: [ { key: 'group:123', sessionId: 'session-a' } ] }  （QQ 桥 GET /api/sessions）
//   { 'group:123': 'session-a' }                      （最简形式）
function normalizeBridgeMap(raw) {
  const out = {};
  const put = (k, v) => {
    if (typeof k !== 'string' || !k) return;
    if (typeof v === 'string' && /^session-/i.test(v)) out[k] = v;
  };
  if (!raw || typeof raw !== 'object') return out;
  const list = Array.isArray(raw) ? raw : raw.sessions;
  if (Array.isArray(list)) {
    for (const it of list) {
      if (it && typeof it === 'object') put(it.key, it.sessionId || it.session_id || it.id);
    }
    return out;
  }
  if (list && typeof list === 'object') {
    for (const k of Object.keys(list)) {
      const v = list[k];
      put(k, typeof v === 'string' ? v : v?.sessionId || v?.session_id || v?.id);
    }
    return out;
  }
  for (const k of Object.keys(raw)) put(k, raw[k]);
  return out;
}

// 从会话标签猜聊天 key：'1034279878 群' → 'group:1034279878'；'1879047761 私聊' → 'private:...'
function guessKeyFromLabel(label) {
  const s = String(label || '');
  const g = /(\d{5,})\s*(?:群|群聊|group)/i.exec(s);
  if (g) return `group:${g[1]}`;
  const p = /(\d{4,})\s*(?:私聊|好友|private)/i.exec(s);
  if (p) return `private:${p[1]}`;
  return '';
}

// 给测试用（DSH 加载插件时只认 name/inject/apply，多导出一个对象无副作用）
export const __test = { normalizeBridgeMap, guessKeyFromLabel, normalizeAt, validDay };


// 原子写：先写临时文件、fsync，再 rename 覆盖。
// 直接 writeFile 一旦在写一半时进程被杀，JSON 只剩半截，下次 readJson 回退成 {}，
// sessions 全没、token 重新生成——配置和状态都必须走这里。
function writeFileAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    try {
      fs.fsyncSync(fd);
    } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function writeJson(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

// 从消息里抠出纯文本（content 可能是 string 或 block 数组）
function textOf(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // 只要真正要发出去的文字块。reasoning/thinking 里也会带 text，
    // 而且常常引一句「只输出 <diary></diary> 里的内容」——那对空标签会让
    // cleanText 先匹配到空段落，把后面真正的日记整篇丢掉（2026-11-21 就是这么失败的）。
    return c
      .filter((b) => b && (b.type === 'text' || (!b.type && typeof b.text === 'string')))
      .map((b) => b.text || '')
      .join('\n');
  }
  if (typeof msg?.text === 'string') return msg.text;
  return '';
}

// 模型有时会在正文前写一段“思考/说明”（中英文都有），这里把正文抠出来：
// 1) 优先取 <diary>…</diary> 标签里的内容；2) 否则剥掉开头的说明行；3) 多段时取最后一段中文段落
export function cleanText(raw) {
  let text = String(raw || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .trim();

  // 取所有 <diary> 段里最长的一段：空标签对（模型/思考里常引 <diary></diary>）
  // 和零碎片段都不能抢走真正的正文。
  const blocks = [...text.matchAll(/<diary>([\s\S]*?)<\/diary>/gi)].map((m) => m[1].trim());
  const longest = blocks.reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest) text = longest;

  const META = /^(rewrite|also|write|that's|that is|here|sure|this|okay|note|the user|好的|好|行|嗯|这是|以下是|我来|我这就|稍等|日记如下|正文如下|写[:：]|正文[:：])/i;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line && !META.test(line) && /[\u4e00-\u9fa5]/.test(line)) break;
    i += 1;
  }
  text = lines.slice(i).join('\n').trim();

  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length > 1) {
    const zh = paras.filter((p) => /[\u4e00-\u9fa5]/.test(p) && !META.test(p));
    if (zh.length) text = zh[zh.length - 1];
  }
  text = text
    .split('\n')
    .filter((l) => !/^\s*<\/?diary>\s*$/i.test(l) && !/^\s*\d+\s+sentences?.*$/i.test(l))
    .join('\n');
  // 去掉落单的代理项与替换符：模型偶尔吐出半个 emoji，写进文件显示成 �
  text = text
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/\uFFFD/g, '');
  return text.trim();
}

// 质量闸门：宁可这天缺一篇，也不把摘要/英文思考/草稿/条目清单写进日记本。
// 触发原因会写进日志，方便回头查那次到底拿到了什么。
export function looksLikeDiary(text) {
  const t = String(text || '').trim();
  const zh = (t.match(/[\u4e00-\u9fa5]/g) || []).length;
  const en = (t.match(/[A-Za-z]/g) || []).length;
  // 繁简：她偶尔整篇写成繁体（2026-11-21 群那本 28 个繁体字）。
  // 这里只统计「简体里不会出现」的字，命中多就让 writeOne 要她重写一遍简体，但不算硬失败。
  const traditional = (t.match(/[從說沒這來個們時會對後開關問題點兒話嗎還裡為與學國東車長門間實寫讀麼樣讓給帶過發現體認識語詞練習雜]/g) || []).length;
  if (zh < 30) return { ok: false, reason: `中文太少（${zh} 字）` };
  if (/\uFFFD|锟斤拷|鈥|鎶|锛|ï¿½/.test(t)) return { ok: false, reason: '正文里有乱码' };
  if (en >= 12 && en / Math.max(1, zh + en) > 0.2) return { ok: false, reason: `英文太多（${en} 个字母 / 中文 ${zh} 字）` };
  if (/m\d{5}\s*[–—\-]\s*m\d{5}/.test(t)) return { ok: false, reason: '是压缩摘要（m00674–m00700 那种）' };
  if (/(日记唤醒|放进\s*<diary>|把日记正文放进)/.test(t)) return { ok: false, reason: '在复述指令' };
  if (/^\s*(v\d+|版本)\s*[:：]/i.test(t)) return { ok: false, reason: '草稿开头（v5: …）' };
  if (/^\s*\d+\s+sentences?/i.test(t)) return { ok: false, reason: '残留写作要求' };
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const listed = lines.filter((l) => /^([-*•]|\d+[.)、])\s+/.test(l)).length;
  if (lines.length >= 3 && listed / lines.length >= 0.5) return { ok: false, reason: `是条目列表（${listed}/${lines.length} 行）` };
  return { ok: true, reason: '', traditional };
}

// ---------------------------------------------------------------- 主体

export function apply(ctx) {
  const cfg = { ...DEFAULTS, ...readJson(CONFIG_FILE, {}) };
  const state = readJson(STATE_FILE, { lastSeen: '', lastWrite: {} });

  // 配置文件被改（手动编辑或控制台写回）就重读，免得每改一次都要重启 DSH。
  // sessions 必须就地在原数组/原对象上合并：正在跑的 writeOne/resetContext 还持有旧会话对象，
  // 直接 Object.assign 换掉数组会让它们随后写回的 cfg 丢掉刚换出来的新会话 id。
  function mergeSessions(freshList) {
    const cur = (cfg.sessions = cfg.sessions || []);
    const byId = new Map(cur.map((s) => [s && s.id, s]));
    const next = [];
    for (const f of Array.isArray(freshList) ? freshList : []) {
      if (!f || !f.id) continue;
      const old = byId.get(f.id);
      if (old) {
        const keep = { bookId: old.bookId, prevIds: old.prevIds, cwd: old.cwd, agentPreset: old.agentPreset };
        Object.assign(old, f);
        for (const k of Object.keys(keep)) if (old[k] === undefined && keep[k] !== undefined) old[k] = keep[k];
        next.push(old);
        byId.delete(f.id);
      } else {
        next.push({ ...f });
      }
    }
    cur.length = 0;
    cur.push(...next);
  }

  let tokenPersisted = false;
  function persistToken() {
    if (!cfg.token || tokenPersisted) return;
    tokenPersisted = true;
    try {
      writeJson(CONFIG_FILE, cfg);
    } catch (e) {
      tokenPersisted = false;
      log('token 落盘失败', e && e.message);
    }
  }

  const onConfigChange = () => {
    try {
      const fresh = readJson(CONFIG_FILE, {});
      if (!fresh || !Object.keys(fresh).length) return;
      if (fresh.token && fresh.token !== cfg.token) return; // 不抢 token
      const sessions = fresh.sessions;
      delete fresh.sessions;
      Object.assign(cfg, fresh);
      if (sessions !== undefined) mergeSessions(sessions);
      if (!cfg.token) {
        cfg.token = crypto.randomBytes(9).toString('hex');
        persistToken();
      }
    } catch (e) {
      log('配置重读失败', e && e.message);
    }
  };
  fs.watchFile(CONFIG_FILE, { interval: 3000 }, onConfigChange);
  if (!cfg.token) {
    cfg.token = crypto.randomBytes(9).toString('hex');
    persistToken();
  }

  // diaryDir 可以在运行时改（热重载），日志路径每次现算，不缓存
  const logFileNow = () => path.join(cfg.diaryDir, 'dsh-diary.log');
  let timer = null; // 下一个「到点」的定时器（22:00）
  let retryTimer = null; // 重试的一次性定时器
  let running = false;
  let server = null;
  let webRouteDispose = null;
  let recapProbe = null; // null=还没试过；true=能静默注入；false=这台 DSH 没有 inject 接口
  let bindHost = ''; // DSH webserver 实际绑定的地址（用来判断是不是只对本机开放）

  function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
    console.log('[dsh-diary]', ...args);
    try {
      fs.mkdirSync(cfg.diaryDir, { recursive: true });
      fs.appendFileSync(logFileNow(), line + '\n', 'utf8');
    } catch {}
  }

  function sessionFile(sess) {
    // bookId 是「这本日记」的稳定身份：清上下文换了会话也不换文件
    return path.join(cfg.diaryDir, `${safeName(sess.bookId || sess.id)}.md`);
  }

  function hasEntry(sess, day) {
    try {
      return fs.readFileSync(sessionFile(sess), 'utf8').includes(`## ${day}`);
    } catch {
      return false;
    }
  }

  function saveState() {
    // 只保留仍然属于某个会话本的键：换会话/移除会话之后 lastWrite/attempts 等会变孤儿，
    // 旧实现只清 resetDue，state.json 只增不减。
    const keep = new Set();
    for (const s of cfg.sessions || []) {
      if (!s) continue;
      for (const k of [s.id, s.bookId, ...(Array.isArray(s.prevIds) ? s.prevIds : [])]) if (k) keep.add(String(k));
    }
    for (const field of ['resetDue', 'lastWrite', 'lastDeliver', 'ruleSent', 'attempts']) {
      const box = state[field];
      if (!box || typeof box !== 'object') continue;
      for (const k of Object.keys(box)) if (!keep.has(k)) delete box[k];
    }
    writeJson(STATE_FILE, state);
  }

  // 固定前缀：写死在这里；网页「提示词」里会把它和正文一起显示，改整段就存 promptFull。
  // 22:00 她多半正在聊天：这条必须读起来像「系统任务」，否则她会当成聊天继续回、或者去翻消息。
  // 也不许她调工具：一旦进工具循环，正文就没了（历史上全是 0 字符）。
  // 注意：这里的 ${day} 是占位符，要留到 promptFor 里再替换。
  const PROMPT_PREFIX =
    '【系统任务·不是聊天·现在必须做完】每天例行的日记，日期 ${day}。\n' +
    '素材就在你上面的对话里，不要去查消息、不要调用任何工具、不要发 QQ、不要问我、也不要等我回复。\n' +
    '看完下面这段，直接一口气写出正文；记不清的细节就按你记得的写，不要现编日期和事实。\n\n';

  // 当前实际生效的提示词模板（保留 ${day}/${file} 占位符，给网页编辑用）
  function promptTemplate(sess) {
    const full = String(sess?.promptFull || '').trim();
    if (full) return full; // 网页里改过的整段：原样用，不再拼前缀，免得重复两遍
    const base = String(sess?.prompt || '').trim() || String(cfg.prompt || '').trim() || DEFAULT_PROMPT;
    return PROMPT_PREFIX + base;
  }

  // ${day}/${file} 会被替换：promptFull 优先，其次前缀+（单条 prompt / 全局 / 默认）
  function promptFor(sess, day) {
    return promptTemplate(sess)
      .replace(/\$\{day\}/g, day)
      .replace(/\$\{file\}/g, sessionFile(sess));
  }

  function messagesOf(session) {
    try {
      return session?.deriveMessages?.() || [];
    } catch {
      return [];
    }
  }

  function pickAssistant(msgs) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === 'assistant') {
        const t = textOf(msgs[i]).trim();
        if (t) return t;
      }
    }
    return '';
  }

  // 等这一回合真正结束，再取回合里最后一条正文。
  // 旧实现「有正文、等满 30 秒就收」会把被截断的半篇日记收下（质量闸门只看长度/形态，拦不住截断），
  // 现在以会话日志的 turn/end 为准；拿不到回合状态时才退回「正文连续两轮不变」的判断。
  async function waitTurnText(session, sessionId, fromIndex, baseSeq, maxMs, target, cancelTurn) {
    const startedAt = Date.now();
    const deadline = startedAt + maxMs;
    let nudged = false;
    let lastStable = '';
    let endedAt = 0; // 第一次看到 turn/end 的时刻：正文可能比事件晚几毫秒才进 store，留个缓冲
    const textNow = () => pickAssistant(messagesOf(session).slice(fromIndex));
    while (Date.now() < deadline) {
      await sleepMs(2000);
      const t = textNow();
      const ts = turnState(sessionId);
      if (!ts.unknown && ts.endSeq > baseSeq && !ts.open) {
        if (t) return t;
        if (!endedAt) endedAt = Date.now();
        else if (Date.now() - endedAt > 6000) return t; // 回合结束了却始终没有正文，交给质量闸门判定
        continue;
      }
      endedAt = 0;
      const waited = Date.now() - startedAt;
      if (ts.unknown && t && t === lastStable && waited > 10_000) return t;
      lastStable = t;
      if (!nudged && !t && waited > 60_000) {
        nudged = true;
        log('60 秒还没正文，纠偏一次');
        try {
          if (typeof target.steer === 'function') {
            await target.steer('别调用任何工具了，现在直接把日记正文写出来，只写正文，不要解释。');
          }
        } catch (e) {
          log(`纠偏失败：${e?.message || e}`);
        }
      }
    }
    const t = textNow();
    const end = turnState(sessionId);
    if (!t) {
      log(`${Math.round(maxMs / 1000)} 秒仍无正文，停掉这个回合，免得她半夜给 QQ 发消息`);
      await cancelTurn();
    } else if (end.open) {
      log(`${Math.round(maxMs / 1000)} 秒到了回合还没结束，先收下现有正文并停回合（这篇可能不完整）`);
      await cancelTurn();
    }
    return t;
  }

  // 会话是否正在跑某个回合（拿不到 running 字段时返回 null，退回"消息静止"判断）
  function isBusy(session) {
    try {
      if (typeof session?.running === 'boolean') return session.running;
      if (typeof session?.isRunning === 'function') return Boolean(session.isRunning());
      if (typeof session?.state?.running === 'boolean') return session.state.running;
    } catch {}
    return null;
  }

  function resolveSession(handle, id) {
    try {
      const s = ctx.sessions.get?.(id);
      if (s) return s;
    } catch {}
    return handle?.session || handle?.agent?.session || handle?.meta?.session || null;
  }

  async function getHandle(sessionId) {
    let handle = null;
    try {
      handle = ctx.agents.get?.(sessionId) || null;
    } catch {}
    if (!handle) {
      // DSH 的签名是 resume({ resumeSessionId, agentOptions })：
      // 不带 agentOptions 时 agent 装配 prompt 会报「prompt variable "{{model}}" has no value」，
      // 回合瞬间 error 结束、一条消息都不产生（看起来就像"没拿到正文"）。
      const sel = selectionOf(sessionId);
      if (sel) log(`resume 带模型选择 ${sessionId}：${sel.provider}/${sel.model}`);
      try {
        handle = await ctx.agents.resume(sel ? { resumeSessionId: sessionId, agentOptions: sel } : { resumeSessionId: sessionId });
      } catch (e) {
        log(`resume 失败 ${sessionId}：${e?.message || e}`);
        try {
          handle = await ctx.agents.resume(sessionId);
        } catch (e2) {
          log(`resume(字符串) 也失败 ${sessionId}：${e2?.message || e2}`);
          return null;
        }
      }
    }
    return handle;
  }

  // DSH 的 workspace 服务在不同版本挂在不同名字下，按可能性依次找
  function serviceOf(...names) {
    for (const n of names) {
      try {
        if (ctx[n]) return ctx[n];
      } catch {}
    }
    return null;
  }

  // 归档旧会话：WorkspaceController.archiveSession(sessionId, { stopActivity })
  async function archiveSession(oldId) {
    let reg = null;
    try {
      reg = ctx.workspaceRegistry;
    } catch {}
    if (!reg) reg = serviceOf('workspaceRegistry');
    if (!reg || typeof reg.archiveSession !== 'function') {
      log(`没找到 workspaceRegistry.archiveSession（${reg ? Object.keys(reg).join(',') : 'no service'}），跳过归档`);
      return false;
    }
    try {
      await reg.archiveSession(oldId, { stopActivity: true });
      return true;
    } catch (e) {
      log(`归档旧会话失败 ${oldId}：${e?.message || e}`);
      return false;
    }
  }

  // 读会话日志头：里面有 agentPreset。新建会话必须带上它，
  // 否则 DSH 重启后 resume 会按默认人格装配，缺 {{model}} 直接报 blocked。
  function headerOf(sessionId) {
    try {
      const root = path.join(os.homedir(), '.dsh', 'sessions');
      for (const g of fs.readdirSync(root)) {
        const f = path.join(root, g, sessionId, 'session.v4.jsonl.zstd');
        if (!fs.existsSync(f)) continue;
        const buf = fs.readFileSync(f);
        const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
        let end = buf.indexOf(magic, 4);
        if (end < 0) end = buf.length;
        const text = zlib.zstdDecompressSync(buf.subarray(0, end)).toString('utf8');
        const first = text.split('\n').find((l) => l.trim());
        return first ? JSON.parse(first) : null;
      }
    } catch (e) {
      log('读会话头失败', sessionId, e?.message || e);
    }
    return null;
  }

  function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 找某个会话的日志文件
  function logFileOf(sessionId) {
    try {
      const root = path.join(os.homedir(), '.dsh', 'sessions');
      for (const g of fs.readdirSync(root)) {
        const f = path.join(root, g, sessionId, 'session.v4.jsonl.zstd');
        if (fs.existsSync(f)) return f;
      }
    } catch {}
    return null;
  }

  // Electron 里的 zstdDecompressSync 对「多帧」数据只解第一帧，而 DSH 的会话日志是一行一帧，
  // 所以必须按 magic 切开逐帧解，否则只能读到 session 头那一行。
  function decodeLog(buf) {
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const offs = [];
    let i = buf.indexOf(MAGIC);
    while (i >= 0) {
      offs.push(i);
      i = buf.indexOf(MAGIC, i + 4);
    }
    if (!offs.length) return zlib.zstdDecompressSync(buf).toString('utf8');
    let out = '';
    for (let k = 0; k < offs.length; k += 1) {
      const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
      try {
        out += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8');
      } catch {}
    }
    return out;
  }

  // 会话日志是「一行一帧」的 zstd；轮询里每 2 秒整份解压一次太贵，
  // 这里按 (size, mtime) 缓存解析后的事件：日志没变化就直接复用。
  const eventsCache = new Map();
  function eventsOf(sessionId) {
    const f = logFileOf(sessionId);
    if (!f || typeof zlib.zstdDecompressSync !== 'function') return null;
    let st = null;
    try {
      st = fs.statSync(f);
    } catch {
      return null;
    }
    const hit = eventsCache.get(f);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.events;
    let text = '';
    try {
      text = decodeLog(fs.readFileSync(f));
    } catch {
      return null;
    }
    const events = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        events.push(JSON.parse(t));
      } catch {}
    }
    if (eventsCache.size > 32) eventsCache.delete(eventsCache.keys().next().value);
    eventsCache.set(f, { size: st.size, mtimeMs: st.mtimeMs, events });
    return events;
  }

  // 会话最后用的模型选择：resume 时必须带上，否则 prompt 里的 {{model}} 没有值
  function selectionOf(sessionId) {
    const events = eventsOf(sessionId);
    if (!events) return null;
    let last = null;
    for (const o of events) {
      if (o && o.type === 'model/selection' && o.data) last = o.data;
    }
    if (!last || !last.provider || !last.model) return null;
    const sel = { provider: last.provider, model: last.model };
    if (last.reasoningEffort) sel.reasoningEffort = last.reasoningEffort;
    return sel;
  }

  // 读会话事件，判断有没有正在跑的回合。
  // DSH 的 followup() 在会话忙时不是排队，而是把消息「插进」当前回合（agent/inbox/spliced），
  // 那样她会把这句当成聊天的一部分继续回消息，日记自然写不出来。
  function turnState(sessionId) {
    const out = { open: null, startSeq: 0, endSeq: 0, splicedSeq: 0, lastSeq: 0, lastTime: 0, stale: false, unknown: false };
    if (typeof zlib.zstdDecompressSync !== 'function') {
      out.unknown = true;
      return out;
    }
    const events = eventsOf(sessionId);
    if (!events) {
      out.unknown = true;
      return out;
    }
    for (const o of events) {
      if (!o || typeof o !== 'object') continue;
      const s = Number(o.seq) || 0;
      if (s > out.lastSeq) {
        out.lastSeq = s;
        out.lastTime = Number(o.time) || 0;
      }
      if (o.type === 'turn/start' && s > out.startSeq) out.startSeq = s;
      else if (o.type === 'turn/end' && s > out.endSeq) out.endSeq = s;
      else if (o.type === 'agent/inbox/spliced' && s > out.splicedSeq) out.splicedSeq = s;
    }
    out.open = out.startSeq > out.endSeq;
    // 宿主在回合中途被杀会留下只有 turn/start 没有 turn/end 的日志：这条「正在聊」会永远开着，
    // 于是每晚写日记都先取消、等 20 秒、判失败，这本日记就再也写不出来。超过两小时没有任何新事件，
    // 就当它是上次崩溃的残骸，按已结束处理（还在真跑的长回合极少超过两小时）。
    const STALE_MS = 2 * 60 * 60 * 1000;
    if (out.open && out.lastTime && Date.now() - out.lastTime > STALE_MS) {
      out.open = false;
      out.stale = true;
    }
    return out;
  }

  // 最近的 turn/end 是不是错误结束（resume 出来的 agent 装配失败会立刻 error，正文自然是空）
  function lastTurnError(sessionId, sinceSeq = 0) {
    const events = eventsOf(sessionId);
    if (!events) return '';
    let msg = '';
    for (const o of events) {
      if (!o || o.type !== 'turn/end') continue;
      if (Number(o.seq) < Number(sinceSeq || 0)) continue;
      const err = o.data && o.data.reason && o.data.reason.error && o.data.reason.error.message;
      if (err) msg = String(err);
    }
    return msg;
  }

  // 离线取某个会话的 cwd（读 DSH 的投影缓存，不依赖会话服务）
  function cwdOf(id) {
    try {
      const f = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', id + '.json');
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'))?.record;
      return String(rec?.identity?.cwd || '');
    } catch {
      return '';
    }
  }

  // 离线取某个会话的标题（读投影缓存的 rows.title.val）
  function titleOf(id) {
    try {
      const f = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', id + '.json');
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'))?.record;
      return String(rec?.rows?.title?.val || '').trim();
    } catch {
      return '';
    }
  }

  // 离线取某个会话的 agentPreset（读投影缓存的 rows.agentPreset.val）
  function presetOf(id) {
    try {
      const f = path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions', id + '.json');
      const rec = JSON.parse(fs.readFileSync(f, 'utf8'))?.record;
      return String(rec?.rows?.agentPreset?.val || '');
    } catch {
      return '';
    }
  }

  // 真实标题/目录/归档状态：读 ~/.dsh/storages（DSH 的会话投影缓存 + workspace.json）
  function scanProjCache() {
    const base = path.join(os.homedir(), '.dsh', 'storages');
    const dir = path.join(base, 'session_projcache', 'sessions');
    const archived = new Set();
    try {
      const w = JSON.parse(fs.readFileSync(path.join(base, 'workspace.json'), 'utf8'));
      for (const id of w?.global?.archivedSessionIds || []) archived.add(id);
    } catch {}
    const out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const id = f.replace(/\.json$/, '');
        try {
          const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))?.record;
          const st = fs.statSync(path.join(dir, f));
          out.push({
            id,
            title: String(rec?.rows?.title?.val || '').trim(),
            cwd: String(rec?.identity?.cwd || ''),
            archived: archived.has(id),
            updatedAt: new Date(st.mtimeMs).toISOString(),
          });
        } catch {}
      }
    } catch (e) {
      log(`扫投影缓存失败：${e?.message || e}`);
    }
    return out;
  }

  let lastRawSessions = [];

  async function listSessions() {
    const cache = scanProjCache();
    const byId = new Map(cache.map((d) => [d.id, d]));
    let items = [];
    try {
      const raw = typeof ctx.sessions?.list === 'function' ? await ctx.sessions.list({}) : [];
      items = Array.isArray(raw) ? raw : raw?.items || [];
      lastRawSessions = items.slice(0, 3);
    } catch (e) {
      log(`列会话失败：${e?.message || e}，改用本地缓存`);
    }
    const merged = new Map(byId);
    for (const it of items) {
      const id = it.sessionId || it.id;
      if (!id) continue;
      const hit = merged.get(id) || { id, title: '', cwd: '', archived: false, updatedAt: '' };
      merged.set(id, { ...hit, live: true, running: Boolean(it.running) });
    }
    return [...merged.values()]
      .filter((x) => x.id && !x.archived && !x.subagent)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // 写完清上下文：新建一个同目录的空会话，成功后再归档旧的；日记文件沿用 bookId，不会被拆成两本
  async function resetContext(sess) {
    const oldId = sess.id;
    const out = { ok: false, oldId, newId: '', archivedOk: false, error: '' };
    try {
      // 先确定原会话目录：新会话必须留在同一目录，否则人格/工作区就跑偏了
      let cwd = sess.cwd || '';
      if (!cwd) {
        try {
          cwd = ctx.sessions.get?.(oldId)?.cwd || '';
        } catch {}
      }
      if (!cwd && oldId) cwd = cwdOf(oldId);
      if (!cwd) {
        out.error = '找不到原会话目录';
        log(`清上下文跳过：${sess.label || sess.bookId || oldId} 找不到原会话目录，不敢在默认目录新建`);
        return out;
      }
      sess.cwd = cwd;
      // 建新会话：必须复用原会话的 agentPreset（qq-chat-v2 之类），
      // 否则新会话重启后人格装配缺 {{model}}，回合会直接 blocked、日记永远写不出来。
      const hdr = headerOf(oldId) || {};
      const preset = sess.agentPreset || hdr.agentPreset || presetOf(oldId);
      if (preset) sess.agentPreset = preset;
      const newSessionId = 'session-' + crypto.randomUUID();
      let createdId = '';
      const meta = { cwd, ...(preset ? { agentPreset: preset } : {}) };
      const attempts = [
        ['agents.create', () => ctx.agents.create({ sessionId: newSessionId, meta })],
        ['sessions.create', () => ctx.sessions.create(newSessionId, { meta })],
      ];
      for (const [name, fn] of attempts) {
        try {
          const r = await fn();
          createdId = pickSessionId(r) || newSessionId;
          log(`新建会话成功（${name}）→ ${createdId}`);
          if (typeof r?.dispose === 'function') {
            try {
              r.dispose();
            } catch {}
          }
          break;
        } catch (e) {
          log(`新建会话失败（${name}）：${e?.message || e}`);
        }
      }
      if (!createdId) {
        // 旧实现是「先归档、再新建」：新建失败就没回滚，旧会话已被归档、配置还指着它，
        // 这本日记从此再也写不出来。现在新建失败就什么都不动，旧会话继续用。
        out.error = '新建会话失败，旧会话保持不动';
        log('清上下文失败：新建会话没成功');
        return out;
      }
      out.newId = createdId;
      // 标题要在归档前取（sessionTitle.get 需要旧会话还在 store 里），拿不到就离线读投影缓存
      let oldTitle = '';
      try {
        const st = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
        const oldSession = ctx.sessions.get?.(oldId);
        if (st?.get && oldSession) oldTitle = String(st.get(oldSession)?.title || '').trim();
      } catch {}
      if (!oldTitle) oldTitle = titleOf(oldId);
      if (oldId) {
        out.archivedOk = await archiveSession(oldId);
        if (!out.archivedOk) log(`旧会话 ${oldId} 没能归档（不影响新会话 ${createdId}）`);
      }
      // 挂回原工作区：之前只在已死的 configuration 路径里 attach，新会话才落到「未分组」
      try {
        const ws = await ctx.workspaceRegistry.create(cwd);
        if (ws?.attachSession) await ws.attachSession(createdId);
      } catch (e) {
        log(`attachSession 失败 ${createdId}：${e?.message || e}`);
      }
      // 标题沿用旧会话（否则被 seedRecap 首条「记忆注入」当成标题）
      if (oldTitle) {
        try {
          const st = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null;
          const newSession = ctx.sessions.get?.(createdId);
          if (st?.rename && newSession) st.rename(newSession, oldTitle);
          else log(`标题改名跳过：${createdId} 无 sessionTitle.rename 或会话不在 store`);
        } catch (e) {
          log(`标题改名失败 ${createdId}：${e?.message || e}`);
        }
      }
      // 就地更新配置里的那一项：热重载之后 cfg.sessions 里可能已经是另一个对象，
      // 只改 sess 再整体覆盖写会把这中间合并进来的会话丢掉。
      const cur = (cfg.sessions || []).find((s) => s && s.id === oldId) || sess;
      Object.assign(cur, {
        bookId: cur.bookId || oldId,
        prevIds: [...(cur.prevIds || []), oldId].slice(-20),
        id: createdId,
      });
      if (cur !== sess) Object.assign(sess, cur);
      writeJson(CONFIG_FILE, cfg);
      invalidateBridgeCache();
      syncBridgeMap(sess, oldId, createdId);
      log(`已清上下文：${sess.label || sess.bookId} 换到新会话 ${createdId}（旧 ${oldId}）`);
      await seedRecap(sess);
      out.ok = true;
      return out;
    } catch (e) {
      out.error = String(e?.message || e);
      log(`清上下文失败：${out.error}`);
      return out;
    }
  }

  // 写完日记之后的「清上下文」判断：勾了 reset 就每次清；勾了 resetEvery 就按到期日清
  async function finishReset(sess) {
    if (sess.reset) {
      const r = await resetContext(sess);
      return r.ok;
    }
    if (!sess.resetEvery) return false;
    const n = Math.max(1, Number(sess.resetEveryDays) || 3);
    state.resetDue = state.resetDue || {};
    const today = dateKey();
    const due = state.resetDue[sess.id];
    if (!due) {
      // 第一次：从现在起算 N 天
      state.resetDue[sess.id] = addDays(today, n);
      saveState();
      return false;
    }
    if (today < due) return false;
    const oldId = sess.id;
    const r = await resetContext(sess); // 成功后 sess.id 已经是新会话
    if (!r.ok) return false; // 没换成就不算「已清」，下次到点再试
    // 旧 id 的到期日已经用过，留着只会变成一条永远没人读的孤儿记录
    delete state.resetDue[oldId];
    state.resetDue[sess.id] = addDays(dateKey(), n);
    saveState();
    log(`${sess.label || sess.id} 满 ${n} 天，归档换新会话`);
    return true;
  }

  // 给「写完不清上下文」的会话补一次规则（清上下文的会话由 seedRecap 带规则）
  async function ensureSearchRule(sess) {
    if (sess?.search === false) return;
    state.ruleSent = state.ruleSent || {};
    if (state.ruleSent[sess.id]) return;
    try {
      const handle = await getHandle(sess.id);
      const agent = handle?.agent && typeof handle.agent === 'object' ? handle.agent : handle;
      if (!agent?.inject) {
        log(`规则注入跳过：${sess.label || sess.id} 没有 inject 接口`);
        return;
      }
      await agent.inject({
        content: [
          {
            type: 'text',
            text:
              `【规则·不需要回复】遇到过去的事（谁说过什么、哪天干了什么），先 grep/read 日记文件 ${sessionFile(sess)} 再回答；` +
              '文件里没有的，就直接说「日记里没记」，不要凭印象编。只读，不要改它。',
          },
        ],
        source: { kind: 'user' },
        role: 'user',
        // DSH 校验要求每条消息有 id：少了它，会话下次加载时报 "lacks an identified message"
        id: crypto.randomUUID(),
      });
      state.ruleSent[sess.id] = dateKey();
      saveState();
      log(`规则注入：${sess.label || sess.id}`);
    } catch (e) {
      log(`规则注入失败 ${sess.id}：${e?.message || e}`);
    }
  }

  // 新对话注入最近 N 篇日记：只走 agent.inject（静默，不触发回复）。
  // 拿不到 inject 接口就跳过并在日志里说清后果——不退回 followup，那会让模型真的回一句，
  // 在 QQ 群/私聊里是能被对方看见的。返回值给调用方决定要不要多写一行日志。
  // 'injected' | 'skipped'（没有 inject） | 'empty'（没有日记可注入） | 'failed'
  async function seedRecap(sess) {
    const days = Number(sess.recapDays ?? cfg.recapDays ?? 3);
    if (!(days > 0)) return 'empty';
    const recap = recapText(sess, days);
    if (!recap) {
      log(`记忆注入跳过：${sess.label || sess.id} 没有可注入的日记`);
      return 'empty';
    }
    try {
      const handle = await getHandle(sess.id);
      const agent = handle?.agent && typeof handle.agent === 'object' ? handle.agent : handle;
      const inject = typeof agent?.inject === 'function' ? agent.inject.bind(agent) : null;
      if (!inject) {
        recapProbe = false;
        log(
          `记忆注入跳过：${sess.label || sess.id} 这个 DSH 没有静默 inject 接口（handle=[${Object.keys(handle || {}).join(',')}]），` +
            '这本新会话不会带旧日记；想要就手动把日记文件塞进对话',
        );
        return 'skipped';
      }
      recapProbe = true;
      const hint =
        sess.search !== false
          ? `\n\n【日记文件】${sessionFile(sess)}\n规则：碰到过去的事（谁说过什么、哪天干了什么），先 grep/read 这个文件再回答；文件里没有的，就直接说「日记里没记」，不要凭印象编。只读，别改它。`
          : '';
      const msg = {
        content: [{ type: 'text', text: `【记忆注入·不需要回复】以下是最近 ${days} 篇日记，用来回忆，不要复述：\n\n${recap}${hint}` }],
        source: { kind: 'user' },
        role: 'user',
        id: crypto.randomUUID(),
      };
      await inject(msg);
      log(`记忆注入：${sess.label || sess.id} 注入最近 ${days} 篇（inject）`);
      return 'injected';
    } catch (e) {
      log(`记忆注入失败 ${sess.id}：${e?.message || e}`);
      return 'failed';
    }
  }

  // 从日记文件里取最近 N 篇（按 ## YYYY-MM-DD 切段，N 是篇数不是天数）
  function recapText(sess, days) {
    let text = '';
    try {
      text = fs.readFileSync(sessionFile(sess), 'utf8');
    } catch {
      return '';
    }
    const parts = text.split(/^## /m).slice(1);
    return parts
      .slice(-Math.max(1, days))
      .map((p) => `## ${p.trim()}`)
      .join('\n\n');
  }

  // 如果这个会话是 QQ 桥接用的，换新会话后顺手把桥的映射也改掉（桥重启后生效）。
  // 没配 bridgeMapFile（没桥）就静默跳过；相对路径按插件目录解析。
  // 只改「已知的映射结构」，不做全量字符串替换：桥的 sessions.json 里还有历史/备注等字段，
  // 递归把每个等于 oldId 的字符串都换掉会误伤，还容易把桥进程正在写的文件写坏。
  function syncBridgeMap(sess, oldId, newId) {
    if (!cfg.bridgeMapFile) return false;
    const file = path.isAbsolute(cfg.bridgeMapFile)
      ? cfg.bridgeMapFile
      : path.resolve(ROOT, cfg.bridgeMapFile);
    try {
      const map = readJson(file, null);
      if (!map || typeof map !== 'object') return false;
      const hit = remapStructure(map, oldId, newId);
      if (hit) {
        writeJson(file, map);
        invalidateBridgeCache();
        log('已同步桥的会话映射（桥重启后生效）');
      }
      return hit;
    } catch (e) {
      log(`同步桥映射失败：${e?.message || e}`);
      return false;
    }
  }

  // 已知形状：{sessions: {key: id}}、{sessions: {key: {sessionId|session_id|id}}}、
  // {sessions: [{key, sessionId|session_id|id}]}、扁平 {key: id}；另外按 keyOf(sess) 精确兜底。
  function remapStructure(map, oldId, newId) {
    let hit = false;
    const patchRecord = (rec) => {
      if (!rec || typeof rec !== 'object') return;
      for (const f of ['sessionId', 'session_id', 'id']) {
        if (rec[f] === oldId) {
          rec[f] = newId;
          hit = true;
        }
      }
    };
    const sessions = map.sessions;
    if (Array.isArray(sessions)) {
      for (const item of sessions) {
        if (!item || typeof item !== 'object') continue;
        if (item.sessionId === oldId || item.session_id === oldId || item.id === oldId) patchRecord(item);
      }
    } else if (sessions && typeof sessions === 'object') {
      for (const k of Object.keys(sessions)) {
        const v = sessions[k];
        if (v === oldId) {
          sessions[k] = newId;
          hit = true;
        } else if (v && typeof v === 'object') {
          patchRecord(v);
        }
      }
    } else {
      for (const k of Object.keys(map)) {
        if (map[k] === oldId) {
          map[k] = newId;
          hit = true;
        }
      }
    }
    // 兜底：桥可能用这本日记自己的 key 存着旧会话 id
    const k = keyOf(sess);
    if (k && map[k] === oldId) {
      map[k] = newId;
      hit = true;
    }
    return hit;
  }

  // ── 跟随桥：把「这本日记该写进哪个聊天会话」的权威交给桥 ─────────────
  // 桥才知道 群/QQ → 当前会话 的绑定（会话是它建的、也是它退役重建的），
  // 所以这里每次写之前都去问一遍，而不是把 id 记死在 config 里。
  let bridgeCache = { at: 0, map: null };
  // reset 改了桥映射之后必须立刻失效缓存，否则 30 秒内再写日记会从缓存里读回旧会话 id，
  // 把日记写回刚归档的那个会话。
  function invalidateBridgeCache() {
    bridgeCache = { at: 0, map: null };
  }
  const onceTags = new Set();

  function logOnce(tag, msg) {
    if (onceTags.has(tag)) return;
    onceTags.add(tag);
    log(msg);
  }

  function bridgeSources() {
    const out = [];
    if (cfg.bridgeMapFile) out.push('file');
    if (cfg.bridgeMapUrl) out.push('url');
    if (cfg.bridgeMapCommand) out.push('command');
    return out;
  }

  function httpGetJson(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
      const req = http.get(url, (res) => {
        const code = Number(res.statusCode || 0);
        if (code >= 400) {
          res.resume();
          reject(new Error(`HTTP ${code}`));
          return;
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (text.length > 4 * 1024 * 1024) req.destroy(new Error('响应太大'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('超时')));
      req.on('error', reject);
    });
  }

  function execJson(cmd, timeout = 4000) {
    return JSON.parse(String(execSync(String(cmd), { timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })));
  }

  // 读桥的映射；任何失败都只记一次日志并返回 null（绝不因此让日记写失败）
  async function readBridgeMap() {
    const sources = bridgeSources();
    if (!sources.length) return null;
    const ttl = Math.max(0, Number(cfg.bridgeMapCacheMs ?? 30000));
    if (bridgeCache.map && Date.now() - bridgeCache.at < ttl) return bridgeCache.map;
    let map = null;
    for (const src of sources) {
      try {
        let raw = null;
        if (src === 'file') {
          const file = path.isAbsolute(cfg.bridgeMapFile) ? cfg.bridgeMapFile : path.resolve(ROOT, cfg.bridgeMapFile);
          raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } else if (src === 'url') {
          raw = await httpGetJson(cfg.bridgeMapUrl);
        } else {
          raw = execJson(cfg.bridgeMapCommand);
        }
        map = normalizeBridgeMap(raw);
      } catch (e) {
        logOnce(`bridge-${src}`, `读桥映射失败（${src}）：${e?.message || e}（先用 config 里的会话 id）`);
        map = null;
      }
      if (map && Object.keys(map).length) break;
    }
    bridgeCache = { at: Date.now(), map: map && Object.keys(map).length ? map : null };
    return bridgeCache.map;
  }

  function keyOf(sess) {
    return String(sess?.key || '').trim() || guessKeyFromLabel(sess?.label);
  }

  function existsInDsh(id) {
    if (!id) return false;
    try {
      if (typeof ctx.sessions?.get === 'function' && ctx.sessions.get(id)) return true;
    } catch {}
    return Boolean(headerOf(id));
  }

  function archivedSet() {
    try {
      const ids = ctx.workspaceRegistry?.archivedSessionIds;
      if (Array.isArray(ids)) return new Set(ids);
    } catch {}
    const out = new Set();
    try {
      const w = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8'));
      for (const id of w?.global?.archivedSessionIds || []) out.add(id);
    } catch {}
    return out;
  }

  async function setArchived(id, on) {
    const reg = ctx.workspaceRegistry || serviceOf('workspaceRegistry');
    try {
      if (on) {
        if (typeof reg?.archiveSession !== 'function') return false;
        await reg.archiveSession(id, { stopActivity: false });
      } else {
        if (typeof reg?.unarchiveSession !== 'function') return false;
        await reg.unarchiveSession(id);
      }
      return true;
    } catch (e) {
      log(`${on ? '归档' : '取消归档'} ${id} 失败：${e?.message || e}`);
      return false;
    }
  }

  // 写之前：①对齐到桥当前的会话 ②会话若被归档，按 ifArchived 决定让路还是跳过
  async function prepareTarget(sess) {
    const before = sess.id;
    try {
      const key = keyOf(sess);
      const map = key ? await readBridgeMap() : null;
      const want = map && key ? map[key] : '';
      if (want && want !== sess.id) {
        if (existsInDsh(want)) {
          sess.prevIds = [...(sess.prevIds || []), sess.id].slice(-20);
          sess.id = want;
          writeJson(CONFIG_FILE, cfg);
          log(`跟随桥：${sess.label || key} ${before} → ${want}`);
        } else {
          logOnce(`missing-${want}`, `桥指的会话 ${want} 在 DSH 里找不到，先不动（沿用 ${sess.id}，等它建好）`);
        }
      }
    } catch (e) {
      log(`跟随桥失败：${e?.message || e}（继续用 ${sess.id}）`);
    }
    if (!archivedSet().has(sess.id)) return { ok: true, restore: false };
    const mode = String(cfg.ifArchived || 'auto');
    const wantsUnarchive = mode === 'unarchive' || (mode === 'auto' && bridgeSources().length > 0);
    if (!wantsUnarchive) {
      return { ok: false, reason: `会话 ${sess.id} 已归档（ifArchived=${mode}），跳过不写` };
    }
    log(`会话 ${sess.id} 已归档，临时取消归档写完再还原`);
    if (!(await setArchived(sess.id, false))) {
      return { ok: false, reason: `会话 ${sess.id} 已归档且取消归档失败，跳过` };
    }
    return { ok: true, restore: true };
  }

  // 日记写完后，把被打断的那条聊天接回去：让她继续回主人最后那条消息
  async function resumeChat(sess, day) {
    try {
      const h = await getHandle(sess.id);
      if (!h) {
        log(`接回聊天失败 ${sess.id}：拿不到 handle`);
        return;
      }
      const t = h.agent && typeof h.agent.followup === 'function' ? h.agent : h;
      // 必须 await：followup 返回的是 Promise，不接住的话失败会变成未处理的 rejection，
      // 在这个宿主里等于把整个进程带崩。
      await t.followup({
        content: [
          {
            type: 'text',
            text: `【系统任务·不是聊天】日记已经插队写完（${day}）。现在回去继续刚才被打断的那段对话，正常回主人最后那条消息就行；不要提日记、不要复述，也不要再写日记。`,
          },
        ],
        source: { kind: 'user' },
        role: 'user',
        id: crypto.randomUUID(),
      });
      log(`已把打断的聊天接回去（${sess.label || sess.id}）`);
    } catch (e) {
      log(`接回聊天失败 ${sess.id}：${e?.message || e}`);
    }
  }

  // 从会话日志里找「上一次叫她写、她其实已经写出来了」的日记正文。
  // 用途：保存失败后重试时，不要再叫她重写一遍（聊天里会堆出好几份），直接认领。
  function claimDiary(sessionId, sinceSeq) {
    const f = logFileOf(sessionId);
    if (!f) return null;
    let text = '';
    try {
      text = decodeLog(fs.readFileSync(f));
    } catch {
      return null;
    }
    let best = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o;
      try {
        o = JSON.parse(t);
      } catch {
        continue;
      }
      if (o.type !== 'assistant/message' || Number(o.seq) <= Number(sinceSeq || 0)) continue;
      const body = (o.data?.message?.content || [])
        .filter((x) => x.type === 'text')
        .map((x) => x.text)
        .join('\n');
      if (!/<diary>/.test(body)) continue;
      best = { seq: Number(o.seq), text: body };
    }
    if (!best) return null;
    const cleaned = cleanText(best.text);
    const check = looksLikeDiary(cleaned);
    if (cleaned.length < 10 || !check.ok) {
      log(`认领时正文不合格（${check.reason || cleaned.length + ' 字符'}），放弃`);
      return null;
    }
    return { seq: best.seq, text: cleaned };
  }

  // 最近一次失败的真实原因（给 /write 和页面用，别再说「没拿到正文」那种笼统话）
  const lastFail = new Map();

  // 叫一个会话写某天的日记，成功后追加到它自己的文件
  async function writeOne(sess, day, why) {
    if (running) {
      lastFail.set(sess.id, '正在写另一本，等它写完再试（同一时间只写一本）');
      log(`跳过 ${sess.label || sess.id} ${day}：已有本在写`);
      return false;
    }
    if (hasEntry(sess, day)) {
      log(`跳过 ${sess.label || sess.id} ${day}：已存在`);
      return true;
    }
    let pendingChat = false;
    let interrupted = false;
    let wroteOk = false;
    let didReset = false;
    running = true;
    const startedAt = Date.now();
    let restoreArchive = false;
    try {
      log(`开始 ${sess.label || sess.id} → ${day}（${why}）`);
      // 写之前先问桥「现在该写进哪个会话」；会话若被归档，按 ifArchived 让路或跳过
      const prep = await prepareTarget(sess);
      if (!prep.ok) {
        lastFail.set(sess.id, prep.reason);
        log(`跳过 ${sess.label || sess.id} ${day}：${prep.reason}`);
        return false;
      }
      restoreArchive = prep.restore;
      const handle = await getHandle(sess.id);
      if (!handle) {
        lastFail.set(sess.id, `resume 返回空：会话 ${sess.id} 起不来（可能已被归档或 DSH 侧不存在）`);
        log(`失败 ${sess.id}：resume 返回空`);
        return false;
      }
      const session = resolveSession(handle, sess.id);
      const before = messagesOf(session).length;
      // 有没有「她还没回」的消息：被她正在处理的这条，打断后要接回来当待办
      try {
        const msgs = messagesOf(session);
        let lastUser = -1;
        let lastAsst = -1;
        msgs.forEach((m, i) => {
          if (m?.role === 'user') lastUser = i;
          else if (m?.role === 'assistant') lastAsst = i;
        });
        pendingChat = lastUser > lastAsst;
      } catch {}
      log(`诊断 ${sess.id}：session=${session ? 'ok' : 'null'}，历史 ${before} 条，handle=[${Object.keys(handle || {}).join(',')}]`);

      // 日记优先：她要是正泡在聊天回合里，直接打断，不等她聊完（聊完常常就过点了）
      const target = handle.agent && typeof handle.agent.followup === 'function' ? handle.agent : handle;
      const cancelTurn = async () => {
        for (const fn of [target.cancel, handle.cancel, handle.agent?.cancel]) {
          if (typeof fn === 'function') {
            try {
              await fn.call(target);
              return true;
            } catch (e) {
              log(`打断出错：${e?.message || e}`);
            }
          }
        }
        return false;
      };
      let ts = turnState(sess.id);
      if (ts.stale) log(`回合记录是残骸（最后事件 ${new Date(ts.lastTime).toLocaleString()}，没有 turn/end），按已结束处理`);
      if (ts.open) {
        interrupted = true;
        // 回合开着就说明她正聊到一半被我们打断：不管日志里最后一条是不是 user，
        // 这段对话都还没回完，写完日记要接回去。
        pendingChat = true;
        log(`她正在聊天回合里（turn seq ${ts.startSeq}），先打断，日记优先`);
        await cancelTurn();
        const until = Date.now() + 20_000;
        while (Date.now() < until) {
          await sleepMs(1000);
          ts = turnState(sess.id);
          if (!ts.open) break;
        }
        if (ts.open) {
          log(`打断后回合仍未结束（turn seq ${ts.startSeq}），这次作废，等重试`);
          return false;
        }
        log(`已打断，回合关闭（seq ${ts.lastSeq}）`);
      }

      const baseSeq = ts.lastSeq;
      // 必须传 UserMessage 对象：{ content:[{type:'text',text}], source:{kind} }
      // 直接传字符串会被原样写进 inbox，把会话日志写坏（agent/inbox/spliced requires message objects）
      const deliver = async (h, text) => {
        const t = h && h.agent && typeof h.agent.followup === 'function' ? h.agent : h;
        // 不 await 的话投递失败会变成未处理的 rejection（能带崩宿主），也看不出有没有投出去
        await t.followup({
          content: [
            {
              type: 'text',
              text,
            },
          ],
          source: { kind: 'user' },
          role: 'user', // 少了这个 DSH 会存成非法消息，重启后整个会话校验失败
          id: crypto.randomUUID(), // 少了这个会报 lacks an identified message
        });
      };
      // 上一次其实已经把日记写进聊天、只是没存下来：直接认领，不再叫她重写一遍
      let claimedText = '';
      const lastD = (state.lastDeliver || {})[sess.id];
      if (lastD && lastD.day === day && lastD.seq > 0) {
        const got = claimDiary(sess.id, lastD.seq);
        if (got) {
          claimedText = got.text;
          log(`认领 ${sess.label || sess.id} ${day}：会话里已有日记（seq ${got.seq}，${claimedText.length} 字），不再重写`);
        }
      }

      if (!claimedText) {
        try {
          await deliver(handle, promptFor(sess, day));
        } catch (e) {
          // 打断有可能把 agent 一起收了，重新取一次 handle 再投
          log(`投递失败 ${sess.id}：${e?.message || e}，重新取 handle 再试`);
          const h2 = await getHandle(sess.id);
          if (!h2) {
            log(`重新取 handle 也失败 ${sess.id}`);
            return false;
          }
          try {
            await deliver(h2, promptFor(sess, day));
          } catch (e2) {
            log(`投递再次失败 ${sess.id}：${e2?.message || e2}`);
            return false;
          }
        }
        state.lastDeliver = state.lastDeliver || {};
        state.lastDeliver[sess.id] = { day, seq: baseSeq, at: new Date().toISOString() };
        saveState();

        // 投完立刻验证：要么开出了新回合，要么消息条数长了起来；两样都没有才作废
        await sleepMs(5000);
        ts = turnState(sess.id);
        const grew = messagesOf(session).length > before;
        const turned = !ts.unknown && ts.startSeq > baseSeq;
        if (!grew && !turned) {
          lastFail.set(sess.id, '提示词投递后没有开出新回合（可能被并进了别的回合），已作废等重试');
          log(`投递没开新回合（start ${ts.startSeq} <= base ${baseSeq}，spliced ${ts.splicedSeq}，消息 ${before}→${messagesOf(session).length}），作废，等重试`);
          await cancelTurn();
          return false;
        }
      }

      let raw = claimedText || (await waitTurnText(session, sess.id, before, baseSeq, cfg.maxWaitMs, target, cancelTurn));
      let text = cleanText(raw);
      let check = looksLikeDiary(text);
      // 整篇写成繁体：要她用简体重写一遍。重写失败也照收——繁体总比缺一天好。
      if (check.ok && check.traditional >= 5) {
        log(`正文是繁体（${check.traditional} 个繁体字），要她重写一遍简体`);
        const before2 = messagesOf(session).length;
        const ts2 = turnState(sess.id);
        const base2 = ts2.endSeq || ts2.startSeq || baseSeq;
        await target.steer('刚才那篇用了繁体字。请用简体中文重写一遍同样的日记正文，仍然只输出 <diary> 里的内容，不要解释。');
        const raw2 = await waitTurnText(session, sess.id, before2, base2, cfg.maxWaitMs, target, cancelTurn);
        const text2 = cleanText(raw2);
        const check2 = looksLikeDiary(text2);
        if (text2.length >= 10 && check2.ok && check2.traditional < 5) {
          text = text2;
          check = check2;
          log(`重写后是简体（${text.length} 字符）`);
        } else {
          log('重写后仍是繁体（或没拿到新正文），按原样收录');
        }
      }
      if (text.length < 10 || !check.ok) {
        const tail = messagesOf(session).slice(before);
        const tErr = lastTurnError(sess.id, baseSeq);
        const reasonText = check.reason || `${text.length} 字符`;
        lastFail.set(sess.id, `正文不合格：${reasonText}${tErr ? `（回合错误：${tErr}）` : ''}`);
        log(`失败 ${sess.id} ${day}：正文不合格（${reasonText}），新增 ${tail.length} 条 roles=[${tail.map((m) => m?.role).join(',')}]${tErr ? `；回合错误：${tErr}` : ''}`);
        return false;
      }

      const header = `## ${day} 日记\n\n`;
      const body = text.endsWith('\n') ? text : text + '\n';
      const file = sessionFile(sess);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 原子写：先拼好整份内容写临时文件，再 rename 覆盖。
      // 直接 append 一旦被打断（进程被杀/两个实例抢写）会留下半截标题，日记就"失踪"了。
      let prev = '';
      try {
        prev = fs.readFileSync(file, 'utf8');
      } catch {}
      if (prev && !prev.endsWith('\n')) prev += '\n'; // 手改过的文件可能没留行尾，别把新标题粘在上一段后面
      const next = (prev || `# ${sess.label || sess.id} 的日记\n\n`) + header + body + '\n';
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, file);

      state.lastWrite = state.lastWrite || {};
      state.lastWrite[sess.id] = { day, at: new Date().toISOString(), chars: text.length, why };
      if (state.lastDeliver) delete state.lastDeliver[sess.id];
      saveState();
      log(`完成 ${sess.label || sess.id} ${day}：${text.length} 字符，耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
      wroteOk = true;
      lastFail.delete(sess.id);
      didReset = await finishReset(sess);
      return true;
    } catch (err) {
      lastFail.set(sess.id, String(err && err.message ? err.message : err));
      log(`失败 ${sess.id} ${day}：${err && err.message ? err.message : err}`);
      return false;
    } finally {
      running = false;
      // 日记插队把聊天打断了：写完之后（或这轮没写成）把那条待回的消息接回去
      if (interrupted && pendingChat && !(wroteOk && didReset)) {
        await resumeChat(sess, day);
      }
      // 为写日记临时解除过归档：写完（且这次没换会话）就还原回去
      if (restoreArchive && !didReset) await setArchived(sess.id, true);
    }
  }

  // 今天是否已经过了写日记的时间点（无效时间回退 22:00，和 atToday 保持同一套解析）
  function pastTodayAt() {
    const p = normalizeAt(cfg.at);
    const h = p ? p.h : 22;
    const m = p ? p.m : 0;
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes() >= h * 60 + m;
  }

  // 该写哪一天：过了 22:00 算今天，没过算昨天（所以第二天早上开机写的是昨天）
  function boundaryDay() {
    const now = new Date();
    return pastTodayAt() ? dateKey(now) : dateKey(new Date(now.getTime() - 86400000));
  }

  // 这一本现在有没有该写的日记；有就返回日期
  function dueDay(sess) {
    const today = dateKey();
    // 跨天补写：上次打开那天缺，且不是今天
    if (cfg.catchUp && state.lastSeen && state.lastSeen !== today && !hasEntry(sess, state.lastSeen)) {
      return state.lastSeen;
    }
    const day = boundaryDay();
    return hasEntry(sess, day) ? null : day;
  }

  // 还没写、还有机会的会话（每本独立判断）
  function pendingSessions() {
    const out = [];
    const now = Date.now();
    for (const sess of cfg.sessions || []) {
      if (!sess || !sess.id || sess.enabled === false) continue;
      const day = dueDay(sess);
      if (!day) continue;
      const rec = (state.attempts || {})[sess.id];
      if (rec && rec.day === day) {
        if (rec.n >= 3) continue; // 这本今天试满 3 次
        if (now - (rec.at || 0) < Number(cfg.retryMs || 300000)) continue; // 等重试间隔
      }
      out.push({ sess, day });
    }
    return out;
  }

  // 告诉桥「这会儿别主动唤醒」（桥看到这个文件就延后，写完删掉）
  function setHold(on, sess, day) {
    if (!cfg.holdFile) return;
    try {
      if (!on) {
        if (fs.existsSync(cfg.holdFile)) fs.unlinkSync(cfg.holdFile);
        return;
      }
      fs.mkdirSync(path.dirname(cfg.holdFile), { recursive: true });
      fs.writeFileSync(
        cfg.holdFile,
        JSON.stringify({ at: new Date().toISOString(), until: Date.now() + 10 * 60 * 1000, session: sess?.label || sess?.id || '', day: day || '' }, null, 2),
        'utf8'
      );
    } catch (e) {
      log(`占位文件写失败：${e?.message || e}`);
    }
  }

  // 到点直接写：先打断在聊的回合，写完日记后由 writeOne 的 finally 把被打断的对话接回去。
  // 不再开轮询等会话空闲（等她聊完常常就过点了），改成「到点就打断、先写日记」。
  async function runDue(why) {
    if (running) {
      // 有本正在写（多半是手动 /write 撞上定时）：等它结束再查一次
      log('有本正在写，稍后再查');
      armRetry(why, 5000);
      return;
    }
    const pending = pendingSessions();
    if (!pending.length) {
      finishRun();
      return;
    }
    for (const { sess, day } of pending) {
      if (running) {
        // 手动写抢了锁：稍后重查
        armRetry(why, 5000);
        return;
      }
      state.attempts = state.attempts || {};
      const rec = state.attempts[sess.id] && state.attempts[sess.id].day === day ? state.attempts[sess.id] : { day, n: 0, at: 0 };
      rec.n += 1;
      rec.at = Date.now();
      state.attempts[sess.id] = rec;
      saveState();
      setHold(true, sess, day);
      let ok = false;
      try {
        ok = await writeOne(sess, day, why || '到点');
      } finally {
        setHold(false);
      }
      if (ok) {
        delete state.attempts[sess.id];
        saveState();
      } else if (rec.n >= 3) {
        log(`${sess.label || sess.id} ${day}：已试 ${rec.n} 次，今天不再重试`);
      }
    }
    // 写完这轮后：还有没写成（冷却中/还剩次数）的按 retryMs 排一次重试；没有就收工
    scheduleRetry(why);
  }

  // 计算并排一次重试（一次性定时器，不是轮询）；没有可重试对象就收工
  function scheduleRetry(why) {
    if (retryTimer) clearTimeout(retryTimer);
    const now = Date.now();
    const retryMs = Number(cfg.retryMs || 300000);
    let earliest = Infinity;
    for (const sess of cfg.sessions || []) {
      if (!sess || !sess.id || sess.enabled === false) continue;
      const day = dueDay(sess);
      if (!day) continue;
      const rec = (state.attempts || {})[sess.id];
      if (rec && rec.day === day) {
        if (rec.n >= 3) continue; // 试满 3 次，今天不排了
        earliest = Math.min(earliest, (rec.at || 0) + retryMs);
      } else {
        earliest = now; // 还没试过的，立即补
      }
    }
    if (!Number.isFinite(earliest)) {
      finishRun();
      return;
    }
    armRetry(why, Math.max(1000, earliest - now));
  }

  function armRetry(why, ms) {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      runDue(why || '重试').catch((e) => log('重试异常', e && e.message));
    }, ms);
    if (retryTimer.unref) retryTimer.unref();
    log(`${Math.round(ms / 1000)} 秒后再跑一次`);
  }

  function finishRun() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    setHold(false);
    state.lastSeen = dateKey();
    saveState();
    log('要写的都写完了，停止');
    scheduleNext();
  }

  function scheduleNext() {
    if (timer) clearTimeout(timer);
    const when = nextAt(cfg.at);
    const ms = Math.max(1000, when.getTime() - Date.now());
    // 定时回调必须自己接住 rejection：runDue 里任何一处同步抛出都会变成
    // 未处理的 Promise rejection，Node 24 默认按异常处理，等于把宿主带走。
    timer = setTimeout(() => {
      runDue(`定时 ${cfg.at}`).catch((e) => log('定时写日记异常', e && e.message));
    }, ms);
    if (timer.unref) timer.unref();
    log(`下一次：${when.toLocaleString()}（${Math.round(ms / 60000)} 分钟后）`);
  }

  // ---------------------------------------------------------------- 控制口
  // 一份实现、两个入口：优先挂到 DSH 自己的 web 服务（同源、不占端口、
  // 不会再有 EADDRINUSE/僵尸实例）；只有拿不到 webServer 时才退回独立端口（cfg.port）。

  // 写路由拿到的是原始 req，req.socket.remoteAddress 由 TCP 层给出、伪造不了，
  // 所以这里能真的按「来源是不是本机」放行；只读路由是 WebResource，宿主只把
  // Fetch Request 交下来（源码注释：without a Peer），拿不到 socket，也就拦不住。
  function isLoopbackAddr(addr) {
    const a = String(addr || '').toLowerCase();
    return a === '::1' || a === '::ffff:0:0:1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
  }

  async function handleRequest(req, res) {
      const url = new URL(req.url, 'http://127.0.0.1');
      const token = req.headers['x-diary-token'] || url.searchParams.get('token');
      const send = (code, data) => {
        const body = JSON.stringify(data, null, 2);
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      };
      // 请求体上限：这些接口只收几百字节的 JSON，不设上限时一个本机进程就能把宿主内存灌满
      const MAX_BODY = 256 * 1024;
      const readJsonBody = async () => {
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) {
            send(413, { error: 'body too large' });
            return null;
          }
        }
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch {
          send(400, { error: 'bad json' });
          return null;
        }
      };
      if (token !== cfg.token) return send(401, { error: 'bad token' });

      try {
        if (req.method === 'POST' && url.pathname === '/config') {
          const body = await readJsonBody();
          if (!body) return;
          cfg.sessions = cfg.sessions || [];
          const at = normalizeAt(body.at);
          if (at) cfg.at = at.text;
          // 新增一本、或把一本从关到开，都不在这里触发写入：点「添加」的那一刻
          // 人往往正跟这个会话聊着，立刻丢一条「写日记」进去会插进对话、还会把
          // 没聊完的回合当素材。补写某天走设置页的「现在写今天」，其余等定时器。
          let added = 0;
          let woke = 0;
          if (Array.isArray(body.sessions)) {
            for (const s of body.sessions) {
              if (!s || !s.id) continue;
              let cur = (cfg.sessions || []).find((x) => x.id === s.id);
              if (!cur) {
                cur = { id: String(s.id), label: String(s.label || s.id) };
                cfg.sessions.push(cur);
                added += 1;
              }
              if (s.label !== undefined) cur.label = String(s.label);
              if (s.key !== undefined) cur.key = String(s.key || '');
              if (s.enabled !== undefined) {
                const was = cur.enabled !== false;
                cur.enabled = s.enabled !== false;
                if (!was && cur.enabled) woke += 1;
              }
              if (s.reset !== undefined) cur.reset = Boolean(s.reset);
              if (s.search !== undefined) cur.search = s.search !== false;
              if (s.recapDays !== undefined) cur.recapDays = Math.max(0, Math.min(365, Number(s.recapDays) || 0));
              if (s.resetEvery !== undefined) cur.resetEvery = Boolean(s.resetEvery);
              if (s.resetEveryDays !== undefined) cur.resetEveryDays = Math.max(1, Math.min(365, Number(s.resetEveryDays) || 3));
              if (s.resetEvery !== undefined || s.resetEveryDays !== undefined) {
                // 勾上或改天数：从现在起重新计时；取消勾选就删掉到期日
                state.resetDue = state.resetDue || {};
                if (cur.resetEvery) state.resetDue[cur.id] = addDays(dateKey(), Number(cur.resetEveryDays) || 3);
                else delete state.resetDue[cur.id];
                saveState();
              }
              if (s.prompt !== undefined) cur.prompt = String(s.prompt || '');
              if (s.promptFull !== undefined) cur.promptFull = String(s.promptFull || '');
              if (s.cwd !== undefined) cur.cwd = String(s.cwd || '');
              // 以前这里还接受 s.newId 直接改会话 id：不归档、不搬桥映射、不动 state，
              // 等于让调用方把一本日记悄悄接到任意会话上，已删除。换会话只走 /reset。
            }
          }
          if (body.prompt !== undefined) cfg.prompt = String(body.prompt || '');
          if (Array.isArray(body.remove)) {
            const ids = new Set(body.remove.map(String));
            cfg.sessions = (cfg.sessions || []).filter((x) => !ids.has(x.id));
          }
          if (Array.isArray(body.add)) {
            for (const s of body.add) {
              if (!s || !s.id) continue;
              if (!(cfg.sessions || []).find((x) => x.id === s.id)) {
                cfg.sessions.push({ id: String(s.id), label: String(s.label || s.id), bookId: String(s.id), cwd: String(s.cwd || '') });
                added += 1;
              }
            }
          }
          writeJson(CONFIG_FILE, cfg);
          // at 改了要立刻按新时间重排，否则要等今天这轮跑完才生效
          scheduleNext();
          if (added || woke) {
            // 只记一笔，不写日记：新加的书从下一次 at 开始算，想补今天用「现在写今天」
            log(`配置变更：新增 ${added} 本、重新启用 ${woke} 本，等下一次 ${cfg.at} 再写`);
          }
          return send(200, { ok: true, at: cfg.at, sessions: cfg.sessions });
        }
        if (req.method === 'GET' && url.pathname === '/read') {
          const id = url.searchParams.get('session') || '';
          const sess = (cfg.sessions || []).find((s) => s.id === id || s.bookId === id);
          if (!sess) return send(404, { error: 'no such session' });
          const file = sessionFile(sess);
          let text = '';
          try {
            text = fs.readFileSync(file, 'utf8');
          } catch {
            text = '（还没有日记）';
          }
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
          res.end(`${file}\n\n${text}`);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/sessions') {
          const items = await listSessions();
          return send(200, { items });
        }
        if (req.method === 'GET' && url.pathname === '/debug') {
          const keys = [];
          try {
            for (const k of Object.keys(ctx)) if (!k.startsWith('_')) keys.push(k);
          } catch {}
          const diag = [];
          for (const s of cfg.sessions || []) {
            try {
              const f = logFileOf(s.id);
              const ts = turnState(s.id);
              const obj = ctx.sessions.get?.(s.id);
              diag.push({ id: s.id, file: f ? 'ok' : 'null', size: f ? fs.statSync(f).size : 0, ts, busy: isBusy(obj), msg: obj ? messagesOf(obj).length : -1 });
            } catch (e) {
              diag.push({ id: s.id, error: String(e?.message || e) });
            }
          }
          return send(200, {
            ctxKeys: keys,
            hasSessionsList: typeof ctx.sessions?.list === 'function',
            sample: JSON.stringify(lastRawSessions[0] ?? null).slice(0, 1200),
            count: lastRawSessions.length,
            diag,
          });
        }
        if (req.method === 'GET' && url.pathname === '/state') {
          const today = dateKey();
          const list = (cfg.sessions || []).map((s) => ({
            ...s,
            promptText: promptTemplate(s),
            file: path.basename(sessionFile(s)),
            todayWritten: hasEntry(s, today),
            last: state.lastWrite?.[s.id] || null,
          }));
          return send(200, {
            at: cfg.at,
            diaryDir: cfg.diaryDir,
            today,
            sessions: list,
            lastSeen: state.lastSeen,
            lastWrite: state.lastWrite,
            running,
            bindHost,
            nonLoopback: Boolean(bindHost) && !isLoopbackAddr(bindHost),
            // true=确认能静默注入；false=确认不行（设置页会提示）；null=还没试过
            recapOk: recapProbe,
          });
        }
        if (req.method === 'POST' && url.pathname === '/toggle') {
          // 有副作用的操作必须是 POST：GET 会被浏览器预取、被爬虫/图片标签顺手触发
          const body = await readJsonBody();
          if (!body) return;
          const id = String(body.id || '');
          const sess = (cfg.sessions || []).find((s) => s.id === id);
          if (!sess) return send(404, { error: 'no such session' });
          sess.enabled = sess.enabled === false ? true : false;
          writeJson(CONFIG_FILE, cfg);
          return send(200, { id, enabled: sess.enabled });
        }
        if (req.method === 'POST' && url.pathname === '/archive') {
          // 清理用：把某个会话直接归档（不动配置）
          const body = await readJsonBody();
          if (!body) return;
          if (!body.sessionId) return send(400, { error: 'sessionId required' });
          const ok = await archiveSession(body.sessionId);
          return send(200, { ok, sessionId: body.sessionId });
        }
        if (req.method === 'POST' && url.pathname === '/reset') {
          const body = await readJsonBody();
          if (!body) return;
          const sess = (cfg.sessions || []).find((s) => s.id === body.sessionId || s.bookId === body.sessionId);
          if (!sess) return send(404, { error: 'no such session' });
          // 成败必须如实返回：旧实现永远 ok:true，前端只能靠 archivedOk 猜
          const r = await resetContext(sess);
          return send(200, { ok: r.ok, oldId: r.oldId, newId: r.newId, archivedOk: r.archivedOk, error: r.error || '' });
        }
        if (req.method === 'POST' && url.pathname === '/selftest') {
          const cwd = path.join(os.homedir(), 'Documents');
          const fake = { id: '', bookId: '', cwd, label: 'selftest' };
          const r = await resetContext(fake);
          const after = r.newId;
          // 自测建出来的空会话用完就归档，别留在会话列表里
          let archived = false;
          if (after) archived = await archiveSession(after);
          return send(200, { ok: r.ok && !!after, err: r.error || '', after, archived });
        }
        if (req.method === 'POST' && url.pathname === '/write') {
          const body = await readJsonBody();
          if (!body) return;
          const dayIn = body.date ? validDay(body.date) : dateKey();
          if (!dayIn) return send(400, { error: 'bad date（要 YYYY-MM-DD）' });
          const day = dayIn;
          const targets = body.sessionId
            ? (cfg.sessions || []).filter((s) => s.id === body.sessionId)
            : (cfg.sessions || []).filter((s) => s.enabled !== false);
          const results = [];
          for (const sess of targets) {
            const ok = await writeOne(sess, day, '手动');
            const lw = (state.lastWrite || {})[sess.id] || {};
            results.push({
              id: sess.id,
              label: sess.label || '',
              ok,
              chars: lw.day === day ? (lw.chars || 0) : 0,
              existed: hasEntry(sess, day),
              error: ok ? '' : (lastFail.get(sess.id) || '这次没写成，看 dsh-diary.log'),
            });
          }
          return send(200, { ok: results.some((r) => r.ok), day, results });
        }
        return send(404, { error: 'not found' });
      } catch (err) {
        return send(500, { error: String(err && err.message ? err.message : err) });
      }
    }

  // 把 DSH web 服务的 Request 适配成 handleRequest 认得的 req/res。
  // 注意：DSH 的 resource 回调不传 Peer（webserver 源码：「becomes a Fetch Request without a Peer」），
  // 所以这里拿不到 principal，也就没法按 owner 校验；真正起作用的只有下面注入的 token，
  // 而 token 又是给同源页面用的——安全边界实际只有「DSH 只绑在回环地址」这一条。
  async function serveWebResource(request) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const pathname = url.pathname.startsWith('/diary-api')
      ? url.pathname.slice('/diary-api'.length) || '/'
      : url.pathname;
    const headers = {};
    for (const [k, v] of request.headers) headers[k] = v;
    // 同源页面拿不到独立凭据，这里补一个内部 token 走统一的校验分支
    headers['x-diary-token'] = cfg.token;
    const req = {
      method: request.method,
      url: `${pathname}${url.search}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (!request.body) return;
        const buf = Buffer.from(await request.arrayBuffer());
        if (buf.length) yield buf;
      },
    };
    let status = 200;
    let payload = '';
    const headersOut = { 'content-type': 'application/json; charset=utf-8' };
    let finish;
    const finished = new Promise((r) => { finish = r; });
    const res = {
      writeHead(code, h) {
        status = code;
        for (const [k, v] of Object.entries(h || {})) headersOut[String(k).toLowerCase()] = v;
        return this;
      },
      setHeader(k, v) { headersOut[String(k).toLowerCase()] = v; },
      getHeader(k) { return headersOut[String(k).toLowerCase()]; },
      end(chunk) {
        payload = chunk == null ? '' : String(chunk);
        finish();
      },
    };
    try {
      await handleRequest(req, res);
    } catch (err) {
      status = 500;
      payload = JSON.stringify({ error: String(err && err.message ? err.message : err) });
      headersOut['content-type'] = 'application/json; charset=utf-8';
      finish();
    }
    await finished;
    return new Response(payload, { status, headers: headersOut });
  }

  // 写操作必须走 handler 路由：resource 路由只接 GET/HEAD（宿主 RESOURCE_METHODS），POST 一律 405。
  // handler 拿不到 peer.principal，所以用「自定义头 + 同源 Origin」挡跨站请求。
  async function writeHandler(req, res, origin) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'only POST' }));
      return;
    }
    if (String(req.headers['x-diary-write'] || '') !== '1') {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'missing x-diary-write' }));
      return;
    }
    // 写操作只认本机来源：局域网能读到日记已经是既成事实，但不能让它改配置/触发归档
    const peer = req.socket && req.socket.remoteAddress;
    if (!isLoopbackAddr(peer)) {
      log(`拒绝非本机写请求：${peer || '(未知来源)'}`);
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'local only' }));
      return;
    }
    const from = req.headers.origin;
    if (from && origin && String(from) !== origin) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'cross-origin' }));
      return;
    }
    const raw = String(req.url || '/');
    const cut = '/diary-api-write';
    const pathname = raw.startsWith(cut) ? raw.slice(cut.length) || '/' : raw;
    const shim = {
      method,
      url: pathname,
      headers: { ...req.headers, 'x-diary-token': cfg.token },
      async *[Symbol.asyncIterator]() {
        for await (const chunk of req) yield chunk;
      },
    };
    await handleRequest(shim, res);
  }

  function startWebRoutes() {
    const webServer = ctx.get('webServer');
    if (!webServer || typeof webServer.register !== 'function') return false;
    let origin = '';
    try { origin = typeof webServer.getOrigin === 'function' ? String(webServer.getOrigin() || '') : ''; } catch {}
    try { bindHost = String(webServer.host || ''); } catch {}
    // 只读接口拦不住来源（WebResource 拿不到 socket），所以绑定地址一旦不是回环，
    // 日记全文对这个网络就是可读的——只能先在日志里喊一声，别让它悄悄发生。
    if (bindHost && !isLoopbackAddr(bindHost)) {
      log(`警告：DSH webserver 绑在 ${bindHost}（非回环地址），/diary-api/state 与 /read 对局域网可读；写接口仍只接受本机请求`);
    }
    const disposers = [];
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: '/diary-api',
        resource: serveWebResource,
      }));
      disposers.push(webServer.register({
        kind: 'prefix',
        path: '/diary-api-write',
        handler: (req, res) => writeHandler(req, res, origin),
      }));
    } catch (e) {
      for (const d of disposers) { try { d(); } catch {} }
      log('挂 DSH web 路由失败，退回独立端口', e && (e.code || e.message));
      return false;
    }
    webRouteDispose = () => { for (const d of disposers) { try { d(); } catch {} } };
    log(`控制口挂在 ${origin || 'DSH'} 的 /diary-api（设置页走这个前缀，没有独立页面）`);
    return true;
  }

  function startServer() {
    const port = Number(cfg.port) || 0;
    if (!port) return;
    server = http.createServer(handleRequest);
    // 以前这里没有 error 监听，listen 撞端口会变成未捕获异常，直接把 DSH 主机拖崩。
    let listenTries = 0;
    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE' && !server.listening && listenTries < 20) {
        listenTries += 1;
        log(`控制口 ${port} 被占用，1 秒后重试（第 ${listenTries} 次）`);
        setTimeout(() => { try { server.listen(port, '127.0.0.1'); } catch {} }, 1000).unref?.();
        return;
      }
      log('控制口出错（不影响写日记）', e && (e.code || e.message));
    });
    server.listen(port, '127.0.0.1', () => {
      log(`控制口 http://127.0.0.1:${port}/state?token=${cfg.token}`);
    });
    if (server.unref) server.unref();
  }

  // ---------------------------------------------------------------- 启动

  const prevLastSeen = state.lastSeen;
  log(`加载：${(cfg.sessions || []).length} 个会话，每天 ${cfg.at}，目录 ${cfg.diaryDir}，上次打开 ${prevLastSeen || '（无）'}`);
  log(`会话日志 zstd：${typeof zlib.zstdDecompressSync === 'function' ? '可用' : '不可用（改用 running 判断忙闲）'}`);
  if (cfg.catchUp) {
    for (const sess of cfg.sessions || []) {
      if (!sess || !sess.id || sess.enabled === false || !prevLastSeen) continue;
      if (prevLastSeen !== dateKey() && !hasEntry(sess, prevLastSeen)) {
        log(`启动补写 ${sess.label || sess.id} → ${prevLastSeen}`);
      }
    }
  }
  if (!startWebRoutes()) startServer();
  // 启动后 3 秒跑一次：有该写的就直接打断写，没有就只排下一次 22:00
  setTimeout(async () => {
    try {
      if (!prevLastSeen) {
        state.lastSeen = dateKey();
        saveState();
        log('首次运行：只记录今天，不补写');
        scheduleNext();
      } else {
        runDue('启动').catch((e) => log('启动写日记异常', e && e.message));
      }
      // 「不清上下文」的会话平时收不到 recap，这里给它们补一次「先查日记再回答」的规则
      for (const sess of cfg.sessions || []) {
        if (sess?.id && sess.enabled !== false) await ensureSearchRule(sess);
      }
    } catch (e) {
      log('启动任务异常', e && e.message);
    }
  }, 3000).unref?.();

  ctx.on('dispose', () => {
    if (timer) clearTimeout(timer);
    if (retryTimer) clearTimeout(retryTimer);
    setHold(false);
    // 不停掉 watchFile 的话，禁用再启用会叠一层 watcher，旧实例还会继续读配置
    try {
      fs.unwatchFile(CONFIG_FILE, onConfigChange);
    } catch {}
    eventsCache.clear();
    if (webRouteDispose) {
      try { webRouteDispose(); } catch {}
      webRouteDispose = null;
    }
    if (server) {
      // 主动把连接与监听都收干净，免得下次启用时端口还没放出来
      try { server.closeAllConnections?.(); } catch {}
      try { server.close(); } catch {}
      server = null;
    }
  });
}

