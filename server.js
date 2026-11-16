// Servidor: site público + API + painel administrativo. Sem dependências externas (Node >= 22.13).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { initDb, driver, get, all, run, insert, tx, hashPw, checkPw, today, addD, nights, TZ } from './src/db.js';
import { PERMS, ROLE_LABEL, perm, pixPayload, buildIcs, parseIcs } from './src/lib.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(ROOT, 'public');
const PORT = +process.env.PORT || 3000;
const cfgAll = async () => Object.fromEntries((await all('SELECT k,v FROM settings')).map((r) => [r.k, r.v]));
const nowIso = () => new Date().toISOString();
const ACTIVE = "('pendente','confirmada','hospedado')";

/* ================= helpers ================= */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const bad = (m, c = 400) => { throw new HttpError(c, m); };
const digits = (s) => String(s || '').replace(/\D/g, '');
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(new Date(s));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

async function paid(resId) { return (await get("SELECT COALESCE(SUM(valor),0) s FROM pagamentos WHERE reserva_id=? AND status='pago'", resId)).s; }
async function decorate(r) {
  if (!r) return r;
  const p = (await paid(r.id));
  return { ...r, noites: nights(r.checkin, r.checkout), pago: p, saldo: Math.max(0, r.total - p) };
}

// Quartos livres de um tipo no período [a,b). Considera reservas, bloqueios iCal e quartos em manutenção.
async function quartosLivres(tipo, a, b, ignoreId = 0) {
  return (await all(`SELECT q.num FROM quartos q WHERE q.tipo=? AND q.status!='manutencao'
    AND NOT EXISTS (SELECT 1 FROM reservas r WHERE r.quarto=q.num AND r.id!=? AND r.status IN ${ACTIVE} AND r.checkin<? AND ?<r.checkout)
    AND NOT EXISTS (SELECT 1 FROM ical_blocos x WHERE x.quarto=q.num AND x.checkin<? AND ?<x.checkout)
    ORDER BY q.num`, tipo, ignoreId, b, a, b, a)).map((r) => r.num);
}
async function quartoLivre(num, a, b, ignoreId = 0) {
  const q = (await get('SELECT tipo FROM quartos WHERE num=?', num));
  return !!q && (await quartosLivres(q.tipo, a, b, ignoreId)).includes(num);
}
async function newCode() { let c; do { c = 'BC-' + Math.floor(1000 + Math.random() * 9000); } while ((await get('SELECT 1 FROM reservas WHERE code=?', c))); return c; }

async function criarReserva(b, { origem, status }) {
  const tipo = (await get('SELECT * FROM tipos WHERE id=?', str(b.tipo)));
  if (!tipo) bad('Acomodação inválida.');
  const a = str(b.checkin, 10), o = str(b.checkout, 10);
  if (!isDate(a) || !isDate(o) || nights(a, o) < 1) bad('Confira as datas de check-in e check-out.');
  if (nights(a, o) > 60) bad('Estadia máxima de 60 noites.');
  const ad = Math.max(1, Math.min(10, num(b.ad, 1))), ch = Math.max(0, Math.min(10, num(b.ch, 0)));
  if (ad + ch > tipo.cap) bad(`Essa acomodação recebe até ${tipo.cap} pessoas.`);
  const nome = str(b.nome, 120), tel = digits(b.tel);
  if (nome.length < 3) bad('Informe o nome completo.');
  if (tel.length < 10) bad('Informe um WhatsApp com DDD.');
  let quarto = str(b.quarto, 4);
  if (quarto) { if (!(await quartoLivre(quarto, a, o))) bad(`Quarto ${quarto} indisponível nesse período.`, 409); }
  else { quarto = (await quartosLivres(tipo.id, a, o))[0]; if (!quarto) bad('Sem disponibilidade dessa acomodação nessas datas.', 409); }
  const total = b.total !== undefined && b.total !== '' ? num(b.total) : nights(a, o) * tipo.tarifa;
  const code = (await newCode());
  const id = (await insert(`INSERT INTO reservas(code,nome,tel,mail,tipo,quarto,checkin,checkout,ad,ch,obs,status,origem,total,criado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, code, nome, tel, str(b.mail, 120), tipo.id, quarto, a, o, ad, ch, str(b.obs, 500), status, origem, total, today()));
  return (await get('SELECT * FROM reservas WHERE id=?', id));
}

async function registrarPagamento(resId, metodo, valor, status, ref = '', userId = null, obs = '') {
  if (!(valor > 0)) bad('Valor inválido.');
  (await run('INSERT INTO pagamentos(reserva_id,metodo,valor,status,ref,obs,criado,user_id) VALUES(?,?,?,?,?,?,?,?)', resId, metodo, valor, status, ref, obs, nowIso(), userId));
  (await confirmaSePago(resId));
}
// Reserva pendente passa a confirmada quando o sinal configurado foi pago.
async function confirmaSePago(resId) {
  const r = (await get('SELECT * FROM reservas WHERE id=?', resId));
  if (r.status !== 'pendente') return;
  const pct = num((await cfgAll()).sinal_pct, 30) / 100;
  if ((await paid(resId)) >= r.total * pct - 0.001) (await run("UPDATE reservas SET status='confirmada' WHERE id=?", resId));
}
function pixPara(r, valor, cfg) {
  const payload = pixPayload({ chave: cfg.pix_chave, nome: cfg.pix_nome, cidade: cfg.cidade, valor, txid: r.code.replace('-', '') + 'P' + Date.now().toString(36).slice(-6) });
  return payload;
}

// Tarefas diárias de arrumação para quartos com hóspede (uma por quarto por dia)
async function garantirTarefasDiarias() {
  const H = today();
  for (const r of (await all("SELECT quarto FROM reservas WHERE status='hospedado'"))) {
    const ex = (await get("SELECT 1 FROM limpeza WHERE quarto=? AND data=? AND tipo='arrumacao'", r.quarto, H));
    if (!ex) (await run("INSERT INTO limpeza(quarto,tipo,status,data,criado) VALUES(?,?,?,?,?)", r.quarto, 'arrumacao', 'pendente', H, nowIso()));
  }
}

/* ================= iCal ================= */
async function syncFeed(feed) {
  let status = 'ok', conflitos = 0;
  try {
    let text;
    const demo = /^\/demo\/booking\/(\w+)\.ics$/.exec(feed.url);
    if (demo) text = demoIcs(demo[1]);
    else {
      if (!/^https?:\/\//i.test(feed.url)) throw new Error('URL inválida');
      const resp = await fetch(feed.url, { signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'PousadaBosque-iCal/1.0' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      text = await resp.text();
    }
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error('Resposta não é um calendário iCal');
    const evs = parseIcs(text).filter((e) => e.checkout >= today());
    await tx(async () => {
      (await run('DELETE FROM ical_blocos WHERE feed_id=?', feed.id));
      for (const e of evs) (await run('INSERT INTO ical_blocos(feed_id,uid,quarto,checkin,checkout,resumo) VALUES(?,?,?,?,?,?)', feed.id, e.uid, feed.quarto, e.checkin, e.checkout, e.resumo || feed.canal));
    });
    conflitos = (await get(`SELECT COUNT(*) n FROM ical_blocos x JOIN reservas r ON r.quarto=x.quarto AND r.status IN ${ACTIVE} AND r.origem!='booking' AND r.checkin<x.checkout AND x.checkin<r.checkout WHERE x.feed_id=?`, feed.id)).n;
    status = `ok · ${evs.length} bloqueio(s)` + (conflitos ? ` · ${conflitos} CONFLITO(S)` : '');
  } catch (e) { status = 'erro: ' + (e.cause?.code || e.message); }
  (await run('UPDATE ical_feeds SET ultimo_sync=?, ultimo_status=?, conflitos=? WHERE id=?', nowIso(), status, conflitos, feed.id));
  return status;
}
async function syncAll() { for (const f of (await all('SELECT * FROM ical_feeds WHERE ativo=1'))) await (await syncFeed(f)); }

/* ================= roteador ================= */
const routes = [];
const on = (method, p, mod, lvl, fn) => routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), mod, lvl, fn });
const pub = (m, p, fn) => on(m, p, null, null, fn);

/* ---------- auth ---------- */
const fails = new Map();
pub('POST', '/api/login', async ({ body, ip, setCookie }) => {
  const key = ip + '|' + str(body.usuario, 40).toLowerCase();
  const f = fails.get(key);
  if (f && f.n >= 5 && Date.now() - f.t < 15 * 60e3) bad('Muitas tentativas. Aguarde 15 minutos.', 429);
  const u = (await get('SELECT * FROM users WHERE usuario=? AND ativo=1', str(body.usuario, 40).toLowerCase()));
  if (!u || !checkPw(String(body.senha || ''), u.senha)) { fails.set(key, { n: (f?.n || 0) + 1, t: Date.now() }); bad('Usuário ou senha incorretos.', 401); }
  fails.delete(key);
  const token = randomBytes(32).toString('hex');
  (await run('INSERT INTO sessions VALUES(?,?,?)', token, u.id, Date.now() + 12 * 3600e3));
  setCookie(token, 12 * 3600);
  return me(u);
});
pub('POST', '/api/logout', async ({ req, setCookie }) => { const t = cookie(req); if (t) (await run('DELETE FROM sessions WHERE token=?', t)); setCookie('', 0); return { ok: true }; });
const me = (u) => ({ id: u.id, nome: u.nome, usuario: u.usuario, role: u.role, roleLabel: ROLE_LABEL[u.role], perms: PERMS[u.role] });
on('GET', '/api/me', '*', null, async ({ u }) => me(u));
on('POST', '/api/me/senha', '*', null, async ({ u, body }) => {
  if (!checkPw(String(body.atual || ''), u.senha)) bad('Senha atual incorreta.');
  if (String(body.nova || '').length < 8) bad('A nova senha precisa de pelo menos 8 caracteres.');
  (await run('UPDATE users SET senha=? WHERE id=?', hashPw(body.nova), u.id));
  return { ok: true };
});

/* ---------- API pública (site) ---------- */
pub('GET', '/api/public/config', async () => ({
  tipos: (await all('SELECT id,nome,cap,tarifa FROM tipos')),
  passeios: (await all('SELECT id,nome,descricao,preco,duracao,img FROM passeios WHERE ativo=1')),
  sinalPct: num((await cfgAll()).sinal_pct, 30), gatewayDemo: (await cfgAll()).gateway === 'demo',
}));
pub('GET', '/api/public/disponibilidade', async ({ q }) => {
  const a = q.get('in'), b = q.get('out');
  if (!isDate(a) || !isDate(b) || nights(a, b) < 1) bad('Datas inválidas.');
  return Object.fromEntries(await Promise.all((await all('SELECT id,tarifa FROM tipos')).map(async (t) => [t.id, { livres: (await quartosLivres(t.id, a, b)).length, total: nights(a, b) * t.tarifa }])));
});
pub('POST', '/api/public/reservas', async ({ body }) => {
  const r = await tx(async () => (await criarReserva(body, { origem: 'site', status: 'pendente' })));
  return { code: r.code, total: r.total, sinal: Math.round(r.total * num((await cfgAll()).sinal_pct, 30)) / 100, tel: r.tel };
});
async function resCliente(code, tel) {
  const r = (await get('SELECT * FROM reservas WHERE code=?', str(code, 12).toUpperCase()));
  const t = digits(tel);
  if (!r || t.length < 8 || !(r.tel === t || r.tel.endsWith(t))) bad('Reserva não encontrada. Confira o código e o telefone.', 404);
  return r;
}
pub('POST', '/api/public/reservas/consulta', async ({ body }) => {
  const r = (await decorate(await resCliente(body.code, body.tel)));
  const { id, tel, mail, ...safe } = r;
  const passeios = (await all('SELECT p.nome, pr.data, pr.pessoas, pr.valor, pr.status FROM passeio_reservas pr JOIN passeios p ON p.id=pr.passeio_id WHERE pr.reserva_id=? ORDER BY pr.data', id));
  const t = (await get('SELECT nome FROM tipos WHERE id=?', r.tipo));
  delete safe.quarto; // número do quarto só é informado no check-in
  return { ...safe, tipoNome: t.nome, passeios, sinal: Math.round(r.total * num((await cfgAll()).sinal_pct, 30)) / 100 };
});
pub('POST', '/api/public/reservas/cancelar', async ({ body }) => {
  const r = (await resCliente(body.code, body.tel));
  if (!['pendente', 'confirmada'].includes(r.status)) bad('Esta reserva não pode mais ser cancelada pelo site.');
  (await run("UPDATE reservas SET status='cancelada' WHERE id=?", r.id));
  return { ok: true };
});
// Pagamento: Pix (BR Code) ou cartão. No modo "demo" o cartão é simulado — veja README para integrar Mercado Pago/Stripe.
pub('POST', '/api/public/pagar', async ({ body }) => {
  const r = (await resCliente(body.code, body.tel));
  if (!['pendente', 'confirmada'].includes(r.status)) bad('Esta reserva não aceita pagamento online.');
  const d = (await decorate(r)); const cfg = (await cfgAll());
  const valor = body.parcial === 'sinal' ? Math.round(r.total * num(cfg.sinal_pct, 30)) / 100 : d.saldo;
  const v = Math.min(valor, d.saldo);
  if (v <= 0) bad('Nada a pagar nesta reserva.');
  if (body.metodo === 'pix') {
    const ref = 'pix-' + randomBytes(4).toString('hex');
    (await run('INSERT INTO pagamentos(reserva_id,metodo,valor,status,ref,criado) VALUES(?,?,?,?,?,?)', r.id, 'pix', v, 'pendente', ref, nowIso()));
    return { metodo: 'pix', valor: v, ref, copiaCola: pixPara(r, v, cfg), demo: cfg.gateway === 'demo' };
  }
  if (body.metodo === 'cartao') {
    if (cfg.gateway !== 'demo') bad('Gateway de cartão não configurado.', 501);
    (await registrarPagamento(r.id, 'cartao', v, 'pago', 'DEMO-' + randomBytes(3).toString('hex')));
    return { metodo: 'cartao', valor: v, aprovado: true, demo: true };
  }
  bad('Forma de pagamento inválida.');
});
// Simula o aviso do banco/PSP confirmando o Pix. Em produção use /api/webhooks/pix com token.
pub('POST', '/api/public/pagar/simular-pix', async ({ body }) => {
  if ((await cfgAll()).gateway !== 'demo') bad('Indisponível.', 403);
  const r = (await resCliente(body.code, body.tel));
  const p = (await get("SELECT * FROM pagamentos WHERE reserva_id=? AND ref=? AND status='pendente'", r.id, str(body.ref, 40)));
  if (!p) bad('Cobrança não encontrada.', 404);
  (await run("UPDATE pagamentos SET status='pago' WHERE id=?", p.id)); (await confirmaSePago(r.id));
  return { ok: true };
});
pub('POST', '/api/webhooks/pix', async ({ body, q }) => {
  if (q.get('token') !== (await cfgAll()).webhook_token) bad('Não autorizado.', 401);
  const p = (await get("SELECT * FROM pagamentos WHERE ref=? AND status='pendente'", str(body.ref, 40)));
  if (!p) bad('Cobrança não encontrada.', 404);
  (await run("UPDATE pagamentos SET status='pago' WHERE id=?", p.id)); (await confirmaSePago(p.reserva_id));
  return { ok: true };
});
pub('POST', '/api/public/passeios/reservar', async ({ body }) => {
  const r = (await resCliente(body.code, body.tel));
  const t = (await get('SELECT * FROM passeios WHERE id=? AND ativo=1', num(body.passeio_id)));
  if (!t) bad('Passeio não encontrado.', 404);
  const data = str(body.data, 10), pessoas = Math.max(1, Math.min(20, num(body.pessoas, 1)));
  if (!isDate(data) || data < today()) bad('Escolha uma data válida.');
  (await run('INSERT INTO passeio_reservas(passeio_id,reserva_id,nome,tel,data,pessoas,valor,status,criado) VALUES(?,?,?,?,?,?,?,?,?)', t.id, r.id, r.nome, r.tel, data, pessoas, t.preco * pessoas, 'solicitado', nowIso()));
  return { ok: true };
});

/* ---------- Dashboard ---------- */
on('GET', '/api/dashboard', 'dashboard', 'r', async () => {
  const H = today(), mes = H.slice(0, 7);
  const totalQ = (await get('SELECT COUNT(*) n FROM quartos')).n;
  const ocupados = (await get("SELECT COUNT(DISTINCT quarto) n FROM reservas WHERE status='hospedado'")).n;
  const fora = (await get("SELECT COUNT(*) n FROM quartos WHERE status='manutencao'")).n;
  const dias = [];
  for (let i = 0; i < 14; i++) {
    const d = addD(H, i);
    const n = (await get(`SELECT COUNT(*) n FROM (SELECT quarto FROM reservas WHERE status IN ${ACTIVE} AND checkin<=? AND ?<checkout UNION SELECT quarto FROM ical_blocos WHERE checkin<=? AND ?<checkout) u`, d, d, d, d)).n;
    dias.push({ data: d, ocupados: n });
  }
  return {
    totalQuartos: totalQ, ocupados, livres: totalQ - ocupados - fora, foraServico: fora,
    chegadas: (await get("SELECT COUNT(*) n FROM reservas WHERE checkin=? AND status IN ('pendente','confirmada')", H)).n,
    saidas: (await get("SELECT COUNT(*) n FROM reservas WHERE checkout=? AND status='hospedado'", H)).n,
    pendentes: (await get("SELECT COUNT(*) n FROM reservas WHERE status='pendente'")).n,
    receitaMes: (await get("SELECT COALESCE(SUM(valor),0) s FROM pagamentos WHERE status='pago' AND substr(criado,1,7)=?", mes)).s,
    aReceber: (await get(`SELECT COALESCE(SUM(r.total - COALESCE((SELECT SUM(valor) FROM pagamentos p WHERE p.reserva_id=r.id AND p.status='pago'),0)),0) s FROM reservas r WHERE r.status IN ('confirmada','hospedado','pendente')`)).s,
    limpezaPendente: (await get("SELECT COUNT(*) n FROM limpeza WHERE status!='pronto'")).n,
    estoqueBaixo: (await get('SELECT COUNT(*) n FROM estoque WHERE qtd<=minimo')).n,
    conflitosIcal: (await get('SELECT COALESCE(SUM(conflitos),0) n FROM ical_feeds')).n,
    passeiosPend: (await get("SELECT COUNT(*) n FROM passeio_reservas WHERE status='solicitado'")).n,
    ocupacao14: dias,
  };
});

/* ---------- Reservas ---------- */
on('GET', '/api/reservas', 'reservas', 'r', async ({ q }) => {
  const where = [], args = [];
  const s = str(q.get('q'), 60);
  if (s) { where.push('(nome ILIKE ? OR code ILIKE ? OR tel ILIKE ?)'); args.push(`%${s}%`, `%${s.toUpperCase()}%`, `%${digits(s) || s}%`); }
  if (q.get('status')) { where.push('status=?'); args.push(q.get('status')); }
  if (q.get('origem')) { where.push('origem=?'); args.push(q.get('origem')); }
  const rows = (await all(`SELECT * FROM reservas ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY checkin DESC LIMIT 300`, ...args));
  return Promise.all(rows.map(decorate));
});
on('GET', '/api/reservas/:id', 'reservas', 'r', async ({ params }) => {
  const r = (await get('SELECT * FROM reservas WHERE id=?', params.id)); if (!r) bad('Reserva não encontrada.', 404);
  return { ...decorate(r), pagamentos: (await all('SELECT * FROM pagamentos WHERE reserva_id=? ORDER BY id', r.id)),
    passeios: (await all('SELECT pr.*, p.nome passeio FROM passeio_reservas pr JOIN passeios p ON p.id=pr.passeio_id WHERE reserva_id=?', r.id)) };
});
on('POST', '/api/reservas', 'reservas', 'w', async ({ body }) => (await decorate(await tx(async () => await criarReserva(body, { origem: ['balcao', 'telefone', 'whatsapp', 'booking'].includes(body.origem) ? body.origem : 'balcao', status: body.status === 'pendente' ? 'pendente' : 'confirmada' })))));
on('PUT', '/api/reservas/:id', 'reservas', 'w', async ({ params, body }) => await tx(async () => {
  const r = (await get('SELECT * FROM reservas WHERE id=?', params.id)); if (!r) bad('Reserva não encontrada.', 404);
  const a = str(body.checkin ?? r.checkin, 10), o = str(body.checkout ?? r.checkout, 10), quarto = str(body.quarto ?? r.quarto, 4);
  if (!isDate(a) || !isDate(o) || nights(a, o) < 1) bad('Datas inválidas.');
  const q = (await get('SELECT * FROM quartos WHERE num=?', quarto)); if (!q) bad('Quarto inválido.');
  const tipo = (await get('SELECT * FROM tipos WHERE id=?', q.tipo));
  const ad = num(body.ad ?? r.ad, 1), ch = num(body.ch ?? r.ch, 0);
  if (ad + ch > tipo.cap) bad(`O quarto ${quarto} recebe até ${tipo.cap} pessoas.`);
  if (ACTIVE.includes(r.status) && !(await quartoLivre(quarto, a, o, r.id))) bad(`Quarto ${quarto} indisponível nesse período.`, 409);
  (await run('UPDATE reservas SET nome=?,tel=?,mail=?,tipo=?,quarto=?,checkin=?,checkout=?,ad=?,ch=?,obs=?,total=? WHERE id=?', str(body.nome ?? r.nome, 120), digits(body.tel ?? r.tel), str(body.mail ?? r.mail, 120), q.tipo, quarto, a, o, ad, ch, str(body.obs ?? r.obs, 500), num(body.total, r.total), r.id));
  return (await decorate((await get('SELECT * FROM reservas WHERE id=?', r.id))));
}));
on('POST', '/api/reservas/:id/status', 'reservas', 'w', async ({ params, body }) => {
  const st = str(body.status, 20);
  if (!['pendente', 'confirmada', 'cancelada'].includes(st)) bad('Use check-in/check-out para alterar para hospedado/finalizada.');
  (await run('UPDATE reservas SET status=? WHERE id=?', st, params.id)); return { ok: true };
});
on('POST', '/api/reservas/:id/checkin', 'checkin', 'w', async ({ params, body }) => await tx(async () => {
  const r = (await get('SELECT * FROM reservas WHERE id=?', params.id)); if (!r) bad('Reserva não encontrada.', 404);
  if (!['pendente', 'confirmada'].includes(r.status)) bad('Só é possível fazer check-in de reservas pendentes ou confirmadas.');
  const q = (await get('SELECT * FROM quartos WHERE num=?', r.quarto));
  if (q.status !== 'limpo' && !body.forcar) bad(`O quarto ${q.num} está "${q.status}". Aguarde a limpeza ou confirme o check-in mesmo assim.`, 409);
  const ocupado = (await get("SELECT code FROM reservas WHERE quarto=? AND status='hospedado' AND id!=?", r.quarto, r.id));
  if (ocupado) bad(`O quarto ${r.quarto} ainda está ocupado pela reserva ${ocupado.code}. Faça o check-out primeiro ou troque o quarto.`, 409);
  (await run("UPDATE reservas SET status='hospedado', checkin_em=? WHERE id=?", nowIso(), r.id));
  return (await decorate((await get('SELECT * FROM reservas WHERE id=?', r.id))));
}));
on('POST', '/api/reservas/:id/checkout', 'checkin', 'w', async ({ params, body }) => await tx(async () => {
  const r = (await get('SELECT * FROM reservas WHERE id=?', params.id)); if (!r) bad('Reserva não encontrada.', 404);
  if (r.status !== 'hospedado') bad('Esta reserva não está hospedada.');
  const d = (await decorate(r));
  if (d.saldo > 0.001 && !body.forcar) bad(`Há saldo em aberto de R$ ${d.saldo.toFixed(2)}. Registre o pagamento ou confirme o check-out mesmo assim.`, 409);
  (await run("UPDATE reservas SET status='finalizada', checkout_em=? WHERE id=?", nowIso(), r.id));
  (await run("UPDATE quartos SET status='sujo' WHERE num=? AND status!='manutencao'", r.quarto));
  (await run("INSERT INTO limpeza(quarto,tipo,status,data,criado) VALUES(?,?,?,?,?)", r.quarto, 'saida', 'pendente', today(), nowIso()));
  return { ok: true };
}));
on('POST', '/api/reservas/:id/pagamentos', 'pagamentos', 'w', async ({ params, body, u }) => {
  const r = (await get('SELECT * FROM reservas WHERE id=?', params.id)); if (!r) bad('Reserva não encontrada.', 404);
  const m = str(body.metodo, 15); if (!['pix', 'cartao', 'dinheiro', 'booking', 'outro'].includes(m)) bad('Forma de pagamento inválida.');
  (await registrarPagamento(r.id, m, num(body.valor), 'pago', str(body.ref, 60), u.id, str(body.obs, 200)));
  return (await decorate((await get('SELECT * FROM reservas WHERE id=?', r.id))));
});

/* ---------- Pagamentos ---------- */
on('GET', '/api/pagamentos', 'pagamentos', 'r', async ({ q }) => {
  const mes = str(q.get('mes'), 7) || today().slice(0, 7);
  return (await all(`SELECT p.*, r.code, r.nome FROM pagamentos p JOIN reservas r ON r.id=p.reserva_id WHERE substr(p.criado,1,7)=? ORDER BY p.id DESC`, mes));
});
on('PUT', '/api/pagamentos/:id', 'pagamentos', 'w', async ({ params, body }) => {
  const st = str(body.status, 10); if (!['pago', 'pendente', 'estornado'].includes(st)) bad('Status inválido.');
  const p = (await get('SELECT * FROM pagamentos WHERE id=?', params.id)); if (!p) bad('Pagamento não encontrado.', 404);
  (await run('UPDATE pagamentos SET status=? WHERE id=?', st, p.id)); if (st === 'pago') (await confirmaSePago(p.reserva_id));
  return { ok: true };
});

/* ---------- Quartos / mapa ---------- */
on('GET', '/api/quartos', 'quartos', 'r', async () => {
  const H = today();
  return Promise.all((await all('SELECT q.*, t.nome "tipoNome" FROM quartos q JOIN tipos t ON t.id=q.tipo ORDER BY q.num')).map(async (q) => {
    const atual = (await get("SELECT id,code,nome,checkout,ad,ch FROM reservas WHERE quarto=? AND status='hospedado'", q.num));
    const prox = (await get(`SELECT id,code,nome,checkin FROM reservas WHERE quarto=? AND status IN ('pendente','confirmada') AND checkout>? ORDER BY checkin LIMIT 1`, q.num, H));
    const bloqueado = (await get('SELECT resumo FROM ical_blocos WHERE quarto=? AND checkin<=? AND ?<checkout', q.num, H, H));
    const estado = q.status === 'manutencao' ? 'manutencao' : atual ? 'ocupado' : bloqueado ? 'bloqueado' : q.status === 'sujo' ? 'sujo' : q.status === 'limpando' ? 'limpando' : 'livre';
    return { ...q, estado, atual, prox, bloqueado: bloqueado?.resumo };
  }));
});
on('PUT', '/api/quartos/:num', 'quartos', 'w', async ({ params, body }) => {
  const st = str(body.status, 12); if (!['limpo', 'sujo', 'limpando', 'manutencao'].includes(st)) bad('Status inválido.');
  const r = (await run('UPDATE quartos SET status=?, obs=? WHERE num=?', st, str(body.obs, 300), params.num));
  if (!r.changes) bad('Quarto não encontrado.', 404);
  if (st === 'sujo') { const ex = (await get("SELECT 1 FROM limpeza WHERE quarto=? AND status!='pronto' AND tipo='saida'", params.num)); if (!ex) (await run("INSERT INTO limpeza(quarto,tipo,status,data,criado) VALUES(?,?,?,?,?)", params.num, 'saida', 'pendente', today(), nowIso())); }
  return { ok: true };
});
on('GET', '/api/mapa', 'quartos', 'r', async ({ q }) => {
  const from = isDate(q.get('from')) ? q.get('from') : today(); const dias = 14, to = addD(from, dias);
  const quartos = (await all('SELECT num,tipo FROM quartos ORDER BY num'));
  const R = (await all(`SELECT id,code,nome,quarto,checkin,checkout,status,origem FROM reservas WHERE status IN ${ACTIVE} AND checkin<? AND ?<checkout`, to, from));
  const B = (await all('SELECT quarto,checkin,checkout,resumo FROM ical_blocos WHERE checkin<? AND ?<checkout', to, from));
  return { from, dias, quartos: quartos.map((k) => ({ ...k, itens: [
    ...R.filter((r) => r.quarto === k.num).map((r) => ({ tipo: 'reserva', id: r.id, rotulo: r.nome, code: r.code, status: r.status, origem: r.origem, checkin: r.checkin, checkout: r.checkout })),
    ...B.filter((b) => b.quarto === k.num).map((b) => ({ tipo: 'bloqueio', rotulo: b.resumo, checkin: b.checkin, checkout: b.checkout })),
  ] })) };
});

/* ---------- Limpeza ---------- */
on('GET', '/api/limpeza', 'limpeza', 'r', async ({ u, q }) => {
  (await garantirTarefasDiarias());
  const own = perm(u.role, 'limpeza') === 'own';
  const rows = (await all(`SELECT l.*, u.nome "atribuidoNome" FROM limpeza l LEFT JOIN users u ON u.id=l.atribuido
    WHERE (l.status!='pronto' OR substr(l.concluido,1,10)=?) ${own ? 'AND (l.atribuido=? OR l.atribuido IS NULL)' : ''} ORDER BY l.status='pronto', l.id`, ...(own ? [today(), u.id] : [today()])));
  return rows;
});
on('POST', '/api/limpeza', 'limpeza', 'w', async ({ body }) => {
  const q = str(body.quarto, 4); if (!(await get('SELECT 1 FROM quartos WHERE num=?', q))) bad('Quarto inválido.');
  const tipo = ['saida', 'arrumacao', 'profunda'].includes(body.tipo) ? body.tipo : 'arrumacao';
  (await run('INSERT INTO limpeza(quarto,tipo,status,atribuido,data,notas,criado) VALUES(?,?,?,?,?,?,?)', q, tipo, 'pendente', body.atribuido || null, today(), str(body.notas, 300), nowIso()));
  return { ok: true };
});
on('PATCH', '/api/limpeza/:id', 'limpeza', 'own', async ({ u, params, body }) => await tx(async () => {
  const t = (await get('SELECT * FROM limpeza WHERE id=?', params.id)); if (!t) bad('Tarefa não encontrada.', 404);
  const lvl = perm(u.role, 'limpeza');
  if (lvl === 'r') bad('Sem permissão.', 403);
  if (lvl === 'own' && t.atribuido && t.atribuido !== u.id) bad('Esta tarefa é de outra pessoa.', 403);
  if (lvl === 'w' && body.atribuido !== undefined) (await run('UPDATE limpeza SET atribuido=? WHERE id=?', body.atribuido || null, t.id));
  if (body.notas !== undefined) (await run('UPDATE limpeza SET notas=? WHERE id=?', str(body.notas, 300), t.id));
  if (body.status) {
    if (!['pendente', 'em_andamento', 'pronto'].includes(body.status)) bad('Status inválido.');
    if (body.status === 'em_andamento') {
      (await run("UPDATE limpeza SET status='em_andamento', iniciado=?, atribuido=COALESCE(atribuido,?) WHERE id=?", nowIso(), u.id, t.id));
      if (t.tipo === 'saida') (await run("UPDATE quartos SET status='limpando' WHERE num=? AND status IN ('sujo','limpo')", t.quarto));
    } else if (body.status === 'pronto') {
      (await run("UPDATE limpeza SET status='pronto', concluido=?, atribuido=COALESCE(atribuido,?) WHERE id=?", nowIso(), u.id, t.id));
      if (t.tipo !== 'arrumacao') (await run("UPDATE quartos SET status='limpo' WHERE num=? AND status IN ('sujo','limpando')", t.quarto));
    } else (await run("UPDATE limpeza SET status='pendente' WHERE id=?", t.id));
  }
  return { ok: true };
}));
on('GET', '/api/equipe-limpeza', 'limpeza', 'w', async () => (await all("SELECT id,nome FROM users WHERE ativo=1 AND role IN ('camareira','governanta')")));

/* ---------- Passeios ---------- */
on('GET', '/api/passeios', 'passeios', 'r', async () => (await all('SELECT * FROM passeios ORDER BY id')));
const tourBody = (b) => [str(b.nome, 100), str(b.descricao, 400), num(b.preco), str(b.duracao, 30), str(b.img, 200) || 'media/d2.jpg', b.ativo === false || b.ativo === 0 ? 0 : 1];
on('POST', '/api/passeios', 'passeios', 'w', async ({ body }) => { if (str(body.nome).length < 3) bad('Informe o nome.'); (await run('INSERT INTO passeios(nome,descricao,preco,duracao,img,ativo) VALUES(?,?,?,?,?,?)', ...tourBody(body))); return { ok: true }; });
on('PUT', '/api/passeios/:id', 'passeios', 'w', async ({ params, body }) => { (await run("UPDATE passeios SET nome=?,descricao=?,preco=?,duracao=?,img=?,ativo=?,fonte='' WHERE id=?", ...tourBody(body), params.id)); return { ok: true }; });
on('GET', '/api/passeios/reservas', 'passeios', 'r', async () => (await all(`SELECT pr.*, p.nome passeio, r.code FROM passeio_reservas pr JOIN passeios p ON p.id=pr.passeio_id LEFT JOIN reservas r ON r.id=pr.reserva_id ORDER BY pr.data DESC, pr.id DESC LIMIT 200`)));
on('POST', '/api/passeios/reservas', 'passeios', 'w', async ({ body }) => {
  const t = (await get('SELECT * FROM passeios WHERE id=?', num(body.passeio_id))); if (!t) bad('Passeio inválido.');
  const data = str(body.data, 10); if (!isDate(data)) bad('Data inválida.');
  const pessoas = Math.max(1, num(body.pessoas, 1));
  const r = body.code ? (await get('SELECT * FROM reservas WHERE code=?', str(body.code, 12).toUpperCase())) : null;
  if (body.code && !r) bad('Código de reserva não encontrado.');
  (await run('INSERT INTO passeio_reservas(passeio_id,reserva_id,nome,tel,data,pessoas,valor,status,criado) VALUES(?,?,?,?,?,?,?,?,?)', t.id, r?.id || null, str(body.nome || r?.nome, 120), digits(body.tel || r?.tel), data, pessoas, t.preco * pessoas, 'confirmado', nowIso()));
  return { ok: true };
});
on('PUT', '/api/passeios/reservas/:id', 'passeios', 'w', async ({ params, body }) => {
  const st = str(body.status, 12); if (!['solicitado', 'confirmado', 'realizado', 'cancelado'].includes(st)) bad('Status inválido.');
  (await run('UPDATE passeio_reservas SET status=? WHERE id=?', st, params.id)); return { ok: true };
});

/* ---------- Estoque ---------- */
on('GET', '/api/estoque', 'estoque', 'r', async () => (await all('SELECT * FROM estoque ORDER BY categoria, nome')));
const itemBody = (b) => [str(b.nome, 80), str(b.categoria, 40) || 'Geral', str(b.unidade, 10) || 'un', num(b.minimo), num(b.custo)];
on('POST', '/api/estoque', 'estoque', 'w', async ({ body, u }) => {
  if (str(body.nome).length < 2) bad('Informe o nome do item.');
  const id = (await insert('INSERT INTO estoque(nome,categoria,unidade,minimo,custo,qtd) VALUES(?,?,?,?,?,?)', ...itemBody(body), num(body.qtd)));
  if (num(body.qtd)) (await run('INSERT INTO estoque_mov(item_id,delta,motivo,user_id,criado) VALUES(?,?,?,?,?)', id, num(body.qtd), 'Estoque inicial', u.id, nowIso()));
  return { ok: true };
});
on('PUT', '/api/estoque/:id', 'estoque', 'w', async ({ params, body }) => { (await run('UPDATE estoque SET nome=?,categoria=?,unidade=?,minimo=?,custo=? WHERE id=?', ...itemBody(body), params.id)); return { ok: true }; });
on('POST', '/api/estoque/:id/mov', 'estoque', 'w', async ({ params, body, u }) => await tx(async () => {
  const it = (await get('SELECT * FROM estoque WHERE id=?', params.id)); if (!it) bad('Item não encontrado.', 404);
  const d = num(body.delta); if (!d) bad('Informe a quantidade.');
  if (it.qtd + d < 0) bad(`Saldo insuficiente (há ${it.qtd} ${it.unidade}).`);
  (await run('UPDATE estoque SET qtd=qtd+? WHERE id=?', d, it.id));
  (await run('INSERT INTO estoque_mov(item_id,delta,motivo,user_id,criado) VALUES(?,?,?,?,?)', it.id, d, str(body.motivo, 120) || (d > 0 ? 'Entrada' : 'Saída'), u.id, nowIso()));
  return { ok: true };
}));
on('GET', '/api/estoque/:id/mov', 'estoque', 'r', async ({ params }) => (await all('SELECT m.*, u.nome usuario FROM estoque_mov m LEFT JOIN users u ON u.id=m.user_id WHERE item_id=? ORDER BY m.id DESC LIMIT 50', params.id)));

/* ---------- Funcionários ---------- */
on('GET', '/api/perfis', 'funcionarios', 'r', async () => ({ perms: PERMS, labels: ROLE_LABEL }));
on('GET', '/api/funcionarios', 'funcionarios', 'r', async () => (await all('SELECT id,nome,usuario,role,ativo,criado FROM users ORDER BY ativo DESC, nome')));
on('POST', '/api/funcionarios', 'funcionarios', 'w', async ({ body }) => {
  const usuario = str(body.usuario, 30).toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) bad('Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _.');
  if (!PERMS[body.role]) bad('Função inválida.');
  if (String(body.senha || '').length < 8) bad('A senha precisa de pelo menos 8 caracteres.');
  if (str(body.nome).length < 2) bad('Informe o nome.');
  if ((await get('SELECT 1 FROM users WHERE usuario=?', usuario))) bad('Esse usuário já existe.', 409);
  (await run('INSERT INTO users(nome,usuario,senha,role,criado) VALUES(?,?,?,?,?)', str(body.nome, 80), usuario, hashPw(body.senha), body.role, nowIso())); return { ok: true };
});
on('PUT', '/api/funcionarios/:id', 'funcionarios', 'w', async ({ params, body, u }) => {
  const t = (await get('SELECT * FROM users WHERE id=?', params.id)); if (!t) bad('Funcionário não encontrado.', 404);
  const role = body.role ?? t.role, ativo = body.ativo === undefined ? t.ativo : body.ativo ? 1 : 0;
  if (!PERMS[role]) bad('Função inválida.');
  if (t.id === u.id && (role !== 'admin' || !ativo)) bad('Você não pode remover seu próprio acesso de administrador.');
  (await run('UPDATE users SET nome=?, role=?, ativo=? WHERE id=?', str(body.nome ?? t.nome, 80), role, ativo, t.id));
  if (body.senha) { if (String(body.senha).length < 8) bad('A senha precisa de pelo menos 8 caracteres.'); (await run('UPDATE users SET senha=? WHERE id=?', hashPw(body.senha), t.id)); }
  if (!ativo || body.senha) (await run('DELETE FROM sessions WHERE user_id=?', t.id));
  return { ok: true };
});

/* ---------- Integrações (iCal / Booking) ---------- */
on('GET', '/api/ical', 'integracoes', 'r', async ({ base }) => {
  const token = (await cfgAll()).ical_token;
  return {
    feeds: (await all('SELECT * FROM ical_feeds ORDER BY quarto, id')),
    exportacao: (await all('SELECT num FROM quartos ORDER BY num')).map((q) => ({ quarto: q.num, url: `${base}/ical/quarto/${q.num}.ics?t=${token}` })),
    todos: `${base}/ical/todos.ics?t=${token}`,
    bloqueios: (await all('SELECT x.*, f.canal FROM ical_blocos x JOIN ical_feeds f ON f.id=x.feed_id ORDER BY x.checkin LIMIT 100')),
  };
});
on('POST', '/api/ical/feeds', 'integracoes', 'w', async ({ body }) => {
  const q = str(body.quarto, 4); if (!(await get('SELECT 1 FROM quartos WHERE num=?', q))) bad('Quarto inválido.');
  const url = str(body.url, 500).replace(/^webcal:/i, 'https:'); if (!/^https?:\/\//i.test(url)) bad('Informe a URL do calendário iCal (começa com https://).');
  (await run('INSERT INTO ical_feeds(quarto,canal,url) VALUES(?,?,?)', q, str(body.canal, 40) || 'Booking.com', url)); return { ok: true };
});
on('DELETE', '/api/ical/feeds/:id', 'integracoes', 'w', async ({ params }) => { (await run('DELETE FROM ical_blocos WHERE feed_id=?', params.id)); (await run('DELETE FROM ical_feeds WHERE id=?', params.id)); return { ok: true }; });
on('POST', '/api/ical/feeds/:id/sync', 'integracoes', 'w', async ({ params }) => {
  const f = (await get('SELECT * FROM ical_feeds WHERE id=?', params.id)); if (!f) bad('Feed não encontrado.', 404);
  return { status: await (await syncFeed(f)) };
});
on('POST', '/api/ical/sync', 'integracoes', 'w', async () => { await (await syncAll()); return { ok: true }; });

/* ---------- Configurações ---------- */
on('GET', '/api/config', 'config', 'r', async () => ({ ...cfgAll(), ical_token: undefined, tipos: (await all('SELECT * FROM tipos')) }));
on('PUT', '/api/config', 'config', 'w', async ({ body }) => {
  for (const k of ['pousada', 'cidade', 'pix_chave', 'pix_nome', 'gateway', 'sinal_pct', 'checkin_hora', 'checkout_hora']) if (body[k] !== undefined) (await run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v', k, str(body[k], 120)));
  for (const t of body.tipos || []) (await run('UPDATE tipos SET tarifa=? WHERE id=?', num(t.tarifa), str(t.id, 5)));
  return { ok: true };
});

/* ================= HTTP ================= */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function cookie(req) { return /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1]; }
const send = (res, code, data, headers = {}) => { const b = typeof data === 'string' ? data : JSON.stringify(data); res.writeHead(code, { 'content-type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(b); };
function readBody(req) {
  return new Promise((ok, no) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) { no(new HttpError(413, 'Corpo muito grande.')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new HttpError(400, 'JSON inválido.')); } }); req.on('error', no); });
}

async function serveStatic(req, res, pathname) {
  if (pathname === '/admin') { res.writeHead(302, { location: '/admin/' }); return res.end(); }
  let rel = decodeURIComponent(pathname); if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB + path.sep)) return send(res, 403, 'Proibido');
  let st; try { st = await stat(file); if (st.isDirectory()) throw 0; } catch { return send(res, 404, 'Não encontrado'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const cache = /\.(jpg|png|mp4|jpeg|webp)$/.test(file) ? 'public, max-age=86400' : 'no-cache';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range && st.size) { // vídeos precisam de Range (Safari/iOS)
    const s = range[1] ? +range[1] : Math.max(0, st.size - +range[2]); const e = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
    if (s > e || s >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${s}-${e}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': e - s + 1, 'cache-control': cache });
    return createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': cache, 'x-content-type-options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// Calendário que a Booking.com publicaria (demonstração). Gera um conflito proposital no quarto 07.
function demoIcs(room) {
  const off = { '05': 12, '06': 20, '07': 3 }[room] ?? 30; const H = today();
  const ev = [{ uid: `bk-${room}-1`, checkin: addD(H, off), checkout: addD(H, off + 3), resumo: 'CLOSED - Not available' }];
  if (room === '07') ev.push({ uid: 'bk-07-conflito', checkin: addD(H, 6), checkout: addD(H, 8), resumo: 'CLOSED - Not available' });
  return buildIcs('Booking.com (demo)', ev);
}

export async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  // Na Vercel os links /ical/*.ics e /demo/*.ics chegam reescritos para /api/...
  const pathname = url.pathname.replace(/^\/api(?=\/(ical|demo)\/.*\.ics$)/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http'; const base = `${proto}://${req.headers.host}`;
  try {
    try { await initDb(); } catch (e) {
      console.error('[db] falha ao iniciar o banco:', e.code || '', e.message);
      const dica = { ENOTFOUND: 'host do banco não encontrado (use a string do Transaction pooler, porta 6543)', ECONNREFUSED: 'conexão recusada', ETIMEDOUT: 'tempo esgotado ao conectar', '28P01': 'senha do banco incorreta', '28000': 'usuário/senha do banco incorretos', XX000: 'tenant/usuário não encontrado: confira o usuário postgres.<ref> na string' }[e.code] || 'confira a DATABASE_URL';
      if (pathname === '/api/health') return send(res, 503, { ok: false, banco: 'indisponivel', codigo: e.code || null, dica });
      return send(res, 503, { erro: `Banco de dados indisponível: ${dica}.` });
    }
    if (pathname === '/api/health') return send(res, 200, { ok: true, banco: driver() });
    let m;
    if ((m = /^\/ical\/(quarto\/(\w+)|todos)\.ics$/.exec(pathname))) {
      if (url.searchParams.get('t') !== (await cfgAll()).ical_token) return send(res, 401, 'Token inválido');
      const where = m[2] ? 'AND quarto=?' : ''; const args = m[2] ? [m[2]] : [];
      // Exporta só reservas diretas (site/balcão); bloqueios importados de outros canais não voltam para o mesmo canal.
      const ev = (await all(`SELECT id,quarto,checkin,checkout,code FROM reservas WHERE status IN ${ACTIVE} AND origem!='booking' AND checkout>=? ${where}`, today(), ...args))
        .map((r) => ({ uid: `${r.code}@bosquecumbuco`, checkin: r.checkin, checkout: r.checkout, resumo: 'Reservado (Pousada Bosque)' }));
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' }); return res.end(buildIcs('Pousada Bosque Cumbuco', ev));
    }
    if ((m = /^\/demo\/booking\/(\w+)\.ics$/.exec(pathname))) {
      res.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8' }); return res.end(demoIcs(m[1]));
    }
    // Vercel Cron (ou qualquer agendador): sincroniza os calendários da Booking. Exige CRON_SECRET.
    if (pathname === '/api/cron/ical') {
      if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return send(res, 401, { erro: 'Não autorizado.' });
      await syncAll(); return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) {
      const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
      if (!route) return send(res, 404, { erro: 'Rota não encontrada.' });
      const params = route.re.exec(pathname).groups || {};
      let u = null;
      if (route.mod) {
        const t = cookie(req);
        const s = t && (await get('SELECT * FROM sessions WHERE token=? AND expira>?', t, Date.now()));
        u = s && (await get('SELECT * FROM users WHERE id=? AND ativo=1', s.user_id));
        if (!u) return send(res, 401, { erro: 'Sessão expirada. Entre novamente.' });
        if (route.mod !== '*') {
          const p = perm(u.role, route.mod);
          if (!p || (route.lvl === 'w' && p !== 'w')) return send(res, 403, { erro: 'Seu nível de acesso não permite esta ação.' });
        }
      }
      let body = {};
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        if (!/application\/json/.test(req.headers['content-type'] || '') && req.headers['content-length'] > 0) return send(res, 415, { erro: 'Use application/json.' });
        body = await readBody(req);
      }
      const setCookie = (v, age) => res.setHeader('set-cookie', `sid=${v}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${proto === 'https' ? '; Secure' : ''}`);
      const out = await route.fn({ req, res, u, params, q: url.searchParams, body, base, ip: req.socket.remoteAddress, setCookie });
      return send(res, 200, out ?? { ok: true });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Método não permitido');
    return await serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, { erro: e.message });
    console.error(e); return send(res, 500, { erro: 'Erro interno.' });
  }
}
export default handler;

// Execução local / VPS: sobe o servidor HTTP e sincroniza o iCal periodicamente.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  http.createServer(handler).listen(PORT, async () => {
    try { await initDb(); await run('DELETE FROM sessions WHERE expira<?', Date.now()); }
    catch (e) { console.error('[db] banco indisponível na inicialização:', e.code || '', e.message); }
    console.log(`Pousada Bosque — http://localhost:${PORT}   painel: http://localhost:${PORT}/admin/  (fuso ${TZ})`);
    syncAll().catch(() => {});
    setInterval(() => syncAll().catch(() => {}), 15 * 60e3).unref();
  });
}
