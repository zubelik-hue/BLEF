// Блеф — игра для свадеб и корпоративов. Сервер комнат на Socket.IO.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Server } from 'socket.io';
import PACKS from './packs.json' with { type: 'json' };

const HERE = path.dirname(fileURLToPath(import.meta.url)); // не __dirname: Netlify объявляет его сам
const PORT = +process.env.PORT || 3000;
const T_WRITE = +process.env.T_WRITE || 45;   // секунд на ложь
const T_VOTE = +process.env.T_VOTE || 30;     // секунд на голосование
const T_REVEAL = +process.env.T_REVEAL || 4;  // секунд на одну карточку раскрытия
const MAX_PLAYERS = 20;
const PTS_TRUTH = 1000, PTS_FOOL = 500;

const app = express();
app.use(express.static(path.join(HERE, 'public')));
app.get('/', (_, res) => res.redirect('/host.html'));
app.get('/health', (_, res) => res.send('ok'));
app.get('/packs', (_, res) => res.json(Object.entries(PACKS).map(([id, p]) => ({ id, label: p.label, title: p.title, n: p.qs.length }))));
const server = http.createServer(app);
const io = new Server(server, { serveClient: false }); // клиент Socket.IO лежит в public/

// ---------- утилиты ----------
const COLS = ['#ff5a4e', '#f6c344', '#4fc3a1', '#5aa9ff', '#c58cff', '#ff8fc7', '#ffa24a', '#7ee081', '#55d6e0', '#e07ad6', '#b5a1ff', '#ffd27a', '#8fd3ff', '#ff7a9c', '#a6e05a', '#d9b38c', '#9ae6c8', '#f59f9f', '#c7c7ff', '#ffe08a'];
const BOT_NAMES = ['Тётя Света', 'Дима', 'Аня', 'Бабушка Нина', 'Артём'];
const GENERIC_LIES = ['с опозданием на час', 'случайно', 'в пижаме', 'с котом на руках', 'под песню Аллы Пугачёвой', 'на спор', 'втайне от всех', 'три раза подряд'];
const ALPHA = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const norm = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rnd = (a, b) => a + Math.random() * (b - a);
function isTruth(text, truth) {
  const a = norm(text), b = norm(truth);
  return a === b || (a.length > 4 && (b.includes(a) || a.includes(b)));
}
function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}
function baseUrl(origin) {
  const pub = process.env.PUBLIC_URL;
  if (pub) return pub.replace(/\/$/, '');
  try { const u = new URL(origin); if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) u.hostname = lanIP(); return u.origin; }
  catch { return `http://${lanIP()}:${PORT}`; }
}

// ---------- комнаты ----------
const rooms = new Map();
function newCode() { let c; do c = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join(''); while (rooms.has(c)); return c; }

async function makeRoom(origin) {
  const code = newCode();
  const url = `${baseUrl(origin)}/play.html?r=${code}`;
  const r = { code, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 480 }), packId: 'wedding', pack: PACKS.wedding,
    players: new Map(), nextId: 1, phase: 'lobby', qi: 0, t: 0, ans: {}, votes: {}, opts: [], rev: [], ri: 0, delta: {}, fool: {},
    timers: [], iv: null, revT: null, touched: Date.now() };
  rooms.set(code, r);
  return r;
}
const later = (r, fn, ms) => r.timers.push(setTimeout(fn, ms));
function clearTimers(r) { r.timers.forEach(clearTimeout); r.timers = []; clearInterval(r.iv); r.iv = null; clearTimeout(r.revT); }
const list = r => [...r.players.values()];
const active = r => list(r).filter(p => p.bot || p.sock);
const Q = r => r.pack.qs[r.qi];

function addPlayer(r, { name, pid = null, bot = false }) {
  const used = new Set(list(r).map(p => p.name.toLowerCase()));
  let n = name, k = 2; while (used.has(n.toLowerCase())) n = `${name} ${k++}`;
  const p = { id: r.nextId++, pid, name: n, bot, sock: null, score: 0, fooled: 0, col: COLS[(r.nextId - 2) % COLS.length] };
  r.players.set(p.id, p);
  return p;
}
function setBots(r, n) {
  for (const p of list(r)) if (p.bot) r.players.delete(p.id);
  BOT_NAMES.slice(0, Math.max(0, Math.min(5, n))).forEach(name => addPlayer(r, { name, bot: true }));
}

// ---------- ход игры ----------
function startTimer(r, sec, onEnd) {
  clearInterval(r.iv); r.t = sec;
  r.iv = setInterval(() => {
    r.t--; io.to(r.code).emit('tick', r.t);
    if (r.t <= 0) { clearInterval(r.iv); r.iv = null; onEnd(); }
  }, 1000);
}
function botLie(r, p) {
  const bots = list(r).filter(x => x.bot), k = bots.indexOf(p), q = Q(r);
  const pool = (q.lies && q.lies.length ? q.lies : GENERIC_LIES).filter(l => !Object.values(r.ans).some(a => norm(a) === norm(l)));
  return (q.lies && q.lies[k] && !Object.values(r.ans).some(a => norm(a) === norm(q.lies[k]))) ? q.lies[k] : (pool[Math.floor(Math.random() * pool.length)] || 'не знаю');
}
function startQuestion(r) {
  clearTimers(r);
  Object.assign(r, { phase: 'write', ans: {}, votes: {}, opts: [], rev: [], ri: 0, delta: {}, fool: {} });
  for (const p of list(r)) if (p.bot) later(r, () => { if (r.phase !== 'write') return; r.ans[p.id] = botLie(r, p); broadcast(r); checkAnswers(r); }, rnd(2500, 9000));
  startTimer(r, T_WRITE, () => toVote(r));
  broadcast(r);
}
function checkAnswers(r) { if (active(r).every(p => p.id in r.ans)) later(r, () => toVote(r), 900); }

function toVote(r) {
  if (r.phase !== 'write') return;
  clearTimers(r);
  for (const p of list(r)) if (p.bot && !(p.id in r.ans)) r.ans[p.id] = botLie(r, p);
  const map = new Map();
  for (const [id, text] of Object.entries(r.ans)) {
    const k = norm(text);
    if (map.has(k)) map.get(k).authors.push(+id); else map.set(k, { text, authors: [+id], truth: false, voters: [] });
  }
  r.opts = shuffle([...map.values(), { text: Q(r).truth, authors: [], truth: true, voters: [] }]);
  r.phase = 'vote';
  for (const p of list(r)) if (p.bot) later(r, () => { if (r.phase !== 'vote') return; botVote(r, p); broadcast(r); checkVotes(r); }, rnd(1500, 6000));
  startTimer(r, T_VOTE, () => toReveal(r));
  broadcast(r);
}
function botVote(r, p) {
  if (p.id in r.votes) return;
  const ok = r.opts.map((o, i) => i).filter(i => !r.opts[i].authors.includes(p.id));
  let pick = r.opts.findIndex(o => o.truth);
  if (Math.random() > 0.35) {
    const pool = ok.flatMap(i => r.opts[i].truth ? [] : r.opts[i].authors.some(a => !r.players.get(a)?.bot) ? [i, i] : [i]);
    if (pool.length) pick = pool[Math.floor(Math.random() * pool.length)];
  }
  r.votes[p.id] = pick;
}
function checkVotes(r) { if (active(r).every(p => p.id in r.votes || r.opts.every(o => o.authors.includes(p.id)))) later(r, () => toReveal(r), 900); }

function toReveal(r) {
  if (r.phase !== 'vote') return;
  clearTimers(r);
  for (const p of list(r)) if (p.bot) botVote(r, p);
  r.opts.forEach(o => o.voters = []);
  for (const [id, i] of Object.entries(r.votes)) r.opts[i]?.voters.push(+id);
  r.delta = {}; r.fool = {};
  for (const p of list(r)) r.delta[p.id] = 0;
  for (const o of r.opts) {
    if (o.truth) o.voters.forEach(v => r.delta[v] += PTS_TRUTH);
    else o.authors.forEach(a => { r.delta[a] += PTS_FOOL * o.voters.length; r.fool[a] = (r.fool[a] || 0) + o.voters.length; });
  }
  r.rev = [...r.opts.filter(o => !o.truth && o.voters.length).sort((a, b) => a.voters.length - b.voters.length), r.opts.find(o => o.truth)];
  r.ri = 0; r.phase = 'reveal';
  r.revT = setTimeout(() => stepReveal(r), T_REVEAL * 1000);
  broadcast(r);
}
function stepReveal(r) {
  if (r.phase !== 'reveal') return;
  clearTimeout(r.revT);
  if (r.ri < r.rev.length - 1) { r.ri++; r.revT = setTimeout(() => stepReveal(r), T_REVEAL * 1000); broadcast(r); }
  else toRound(r);
}
function toRound(r) {
  clearTimers(r);
  for (const p of list(r)) { p.score += r.delta[p.id] || 0; p.fooled += r.fool[p.id] || 0; }
  r.phase = r.qi < r.pack.qs.length - 1 ? 'round' : 'final';
  broadcast(r);
}
function next(r) {
  switch (r.phase) {
    case 'lobby': if (list(r).length >= 2) { r.qi = 0; startQuestion(r); } break;
    case 'write': toVote(r); break;
    case 'vote': toReveal(r); break;
    case 'reveal': stepReveal(r); break;
    case 'round': r.qi++; startQuestion(r); break;
    case 'final': reset(r); break;
  }
}
function reset(r) {
  clearTimers(r);
  for (const p of list(r)) { p.score = 0; p.fooled = 0; }
  Object.assign(r, { phase: 'lobby', qi: 0, ans: {}, votes: {}, opts: [], rev: [], ri: 0, delta: {}, fool: {} });
  broadcast(r);
}

// ---------- что видит каждый ----------
const ranking = r => list(r).sort((a, b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, col: p.col, score: p.score, delta: r.delta[p.id] || 0, bot: p.bot }));
function hostView(r) {
  const v = { code: r.code, url: r.url, qr: r.qr, phase: r.phase, qi: r.qi, total: r.pack.qs.length, title: r.pack.title, packId: r.packId, t: r.t,
    q: r.phase === 'lobby' ? null : Q(r)?.q,
    players: list(r).map(p => ({ id: p.id, name: p.name, col: p.col, bot: p.bot, on: p.bot || !!p.sock, answered: p.id in r.ans, voted: p.id in r.votes })) };
  if (r.phase === 'vote') v.opts = r.opts.map(o => o.text);
  if (r.phase === 'reveal') {
    const o = r.rev[r.ri], nm = id => r.players.get(id)?.name || '?';
    v.card = { text: o.text, truth: o.truth, voters: o.voters.map(nm), authors: o.authors.map(nm), pts: o.truth ? PTS_TRUTH : PTS_FOOL * o.voters.length };
    v.ri = r.ri; v.revLen = r.rev.length;
  }
  if (r.phase === 'round' || r.phase === 'final') v.ranking = ranking(r);
  if (r.phase === 'final') { const l = list(r).sort((a, b) => b.fooled - a.fooled)[0]; if (l && l.fooled) v.liar = { name: l.name, fooled: l.fooled }; }
  return v;
}
function playerView(r, p) {
  const v = { phase: r.phase, code: r.code, title: r.pack.title, name: p.name, col: p.col, score: p.score, qi: r.qi, total: r.pack.qs.length };
  if (r.phase === 'write' || r.phase === 'vote') { v.q = Q(r).q; v.t = r.t; }
  if (r.phase === 'write') v.lie = r.ans[p.id] ?? null;
  if (r.phase === 'vote') {
    v.voted = p.id in r.votes ? r.opts[r.votes[p.id]]?.text : null;
    v.opts = r.opts.map((o, i) => ({ i, text: o.text })).filter(o => !r.opts[o.i].authors.includes(p.id));
  }
  if (r.phase === 'round' || r.phase === 'final') {
    v.delta = r.delta[p.id] || 0;
    v.place = ranking(r).findIndex(x => x.id === p.id) + 1; v.n = r.players.size;
  }
  return v;
}
function broadcast(r) {
  r.touched = Date.now();
  io.to('h:' + r.code).emit('state', hostView(r));
  for (const p of list(r)) if (p.sock) io.to(p.sock).emit('you', playerView(r, p));
}

// ---------- сокеты ----------
io.on('connection', s => {
  const hostRoom = () => rooms.get(s.data.host);
  const me = () => { const r = rooms.get(s.data.room); return r && { r, p: r.players.get(s.data.pid) }; };
  const attachHost = r => { s.data.host = r.code; s.join('h:' + r.code); s.join(r.code); s.emit('state', hostView(r)); };

  s.on('host:create', async ({ origin } = {}, ack) => { const r = await makeRoom(origin); setBots(r, 0); attachHost(r); ack?.({ code: r.code }); });
  s.on('host:resume', ({ code } = {}, ack) => { const r = rooms.get(String(code).toUpperCase()); if (!r) return ack?.({ ok: false }); attachHost(r); ack?.({ ok: true }); });
  s.on('host:pack', ({ id, custom } = {}, ack) => {
    const r = hostRoom(); if (!r || r.phase !== 'lobby') return ack?.({ ok: false });
    if (custom) {
      const qs = (custom.qs || []).slice(0, 30).map(q => {
        let text = clean(q.q, 140); if (!text.includes('___')) text += ' ___';
        return { q: text, truth: clean(q.truth, 60), lies: (q.lies || []).map(l => clean(l, 60)).filter(Boolean).slice(0, 5) };
      }).filter(q => q.q.length > 4 && q.truth);
      if (!qs.length) return ack?.({ ok: false, err: 'Не нашёл ни одного вопроса' });
      r.pack = { title: clean(custom.title, 60) || 'Наш праздник', qs }; r.packId = 'custom';
    } else if (PACKS[id]) { r.pack = PACKS[id]; r.packId = id; }
    broadcast(r); ack?.({ ok: true, n: r.pack.qs.length });
  });
  s.on('host:bots', n => { const r = hostRoom(); if (r && r.phase === 'lobby') { setBots(r, +n || 0); broadcast(r); } });
  s.on('host:next', () => { const r = hostRoom(); if (r) next(r); });
  s.on('host:reset', () => { const r = hostRoom(); if (r) reset(r); });
  s.on('host:kick', id => {
    const r = hostRoom(), p = r?.players.get(+id); if (!p || r.phase !== 'lobby') return;
    if (p.sock) io.to(p.sock).emit('kicked'); r.players.delete(p.id); broadcast(r);
  });

  s.on('p:join', ({ code, name, pid } = {}, ack) => {
    const r = rooms.get(String(code || '').toUpperCase().trim());
    if (!r) return ack?.({ ok: false, err: 'Комната не найдена. Проверьте код на экране.' });
    let p = pid && list(r).find(x => x.pid === pid);
    if (!p) {
      const nm = clean(name, 18); if (!nm) return ack?.({ ok: false, err: 'Введите имя' });
      if (r.players.size >= MAX_PLAYERS) return ack?.({ ok: false, err: 'Комната заполнена' });
      p = addPlayer(r, { name: nm, pid: clean(pid, 40) || null });
    }
    if (p.sock && p.sock !== s.id) io.to(p.sock).emit('kicked');
    p.sock = s.id; s.data.room = r.code; s.data.pid = p.id; s.join(r.code);
    ack?.({ ok: true }); broadcast(r);
  });
  s.on('p:lie', (text, ack) => {
    const m = me(); if (!m?.p || m.r.phase !== 'write' || m.p.id in m.r.ans) return ack?.({ ok: false });
    const t = clean(text, 60); if (!t) return ack?.({ ok: false, warn: 'Напишите хоть что-нибудь' });
    if (isTruth(t, Q(m.r).truth)) return ack?.({ ok: false, warn: 'Ого, это и есть правда! Придумайте ложь, а правду угадаете при голосовании.' });
    m.r.ans[m.p.id] = t; ack?.({ ok: true }); broadcast(m.r); checkAnswers(m.r);
  });
  s.on('p:vote', (i, ack) => {
    const m = me(); if (!m?.p || m.r.phase !== 'vote' || m.p.id in m.r.votes) return ack?.({ ok: false });
    const o = m.r.opts[+i]; if (!o || o.authors.includes(m.p.id)) return ack?.({ ok: false });
    m.r.votes[m.p.id] = +i; ack?.({ ok: true }); broadcast(m.r); checkVotes(m.r);
  });

  s.on('disconnect', () => {
    const m = me(); if (!m?.p || m.p.sock !== s.id) return;
    const { r, p } = m; p.sock = null; broadcast(r);
    // Соединения иногда рвутся у всех сразу (перезапуск, лимит хостинга) — ждём переподключения, прежде чем двигать игру.
    setTimeout(() => {
      if (p.sock || !r.players.has(p.id)) return;
      if (r.phase === 'write') checkAnswers(r); else if (r.phase === 'vote') checkVotes(r);
    }, 8000);
  });
});

// старые комнаты удаляем через 6 часов тишины
setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.touched > 6 * 3600e3) { clearTimers(r); rooms.delete(c); } }, 10 * 60e3).unref();

export { server, io, rooms, lanIP, PORT };
