// Camada de banco: PostgreSQL (Supabase em produção; PGlite embutido para desenvolvimento local).
// API assíncrona mínima: get / all / run / insert / exec / tx. Use "?" como placeholder.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { SCHEMA, RLS } from './schema.js';

export const TZ = 'America/Fortaleza';
export const iso = (d) => d.toLocaleDateString('sv-SE', { timeZone: TZ });
export const today = () => iso(new Date());
export const addD = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toLocaleDateString('sv-SE'); };
export const nights = (a, b) => Math.max(0, Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 864e5));

export function hashPw(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(pw, salt, 64).toString('hex');
}
export function checkPw(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const h = scryptSync(pw, salt, 64);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && timingSafeEqual(h, b);
}

/* ---------- conexão ---------- */
// COUNT()/SUM() chegam como bigint/numeric (texto); queremos números.
const parseInt10 = (v) => parseInt(v, 10);
pg.types.setTypeParser(20, parseInt10);
pg.types.setTypeParser(1700, parseFloat);

let base = null;            // { query(sql, params) -> rows[], tx(fn) }
const als = new AsyncLocalStorage();
let readyP = null;

const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); };
const norm = (args) => args.map((a) => (a === undefined ? null : a));

async function connect() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const local = /@(localhost|127\.0\.0\.1)/.test(url);
    const pool = new pg.Pool({ connectionString: url, max: +process.env.PG_POOL_MAX || 3, ssl: local ? false : { rejectUnauthorized: false } });
    return {
      driver: 'postgres',
      query: async (sql, params = []) => { const r = await pool.query(sql, params); return { rows: r.rows, count: r.rowCount }; },
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: async (sql, params = []) => { const r = await c.query(sql, params); return { rows: r.rows, count: r.rowCount }; } });
          await c.query('COMMIT'); return out;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
      exec: async (sql) => { await pool.query(sql); },
    };
  }
  // Sem DATABASE_URL: Postgres embutido (PGlite) só para desenvolvimento/testes locais.
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.DATA_DIR || './data';
  if (!process.env.PGLITE_MEMORY) mkdirSync(dir, { recursive: true });
  const lite = new PGlite(process.env.PGLITE_MEMORY ? undefined : path.join(dir, 'pglite'), { parsers: { 20: parseInt10, 1700: parseFloat } });
  await lite.waitReady;
  const wrap = (c) => async (sql, params = []) => { const r = await c.query(sql, params); return { rows: r.rows, count: r.affectedRows ?? r.rows.length }; };
  return {
    driver: 'pglite', query: wrap(lite),
    tx: (fn) => lite.transaction((t) => fn({ query: wrap(t) })),
    exec: async (sql) => { await lite.exec(sql); },
  };
}
const cur = () => als.getStore() || base;
async function run_(sql, args) { const r = await cur().query(toPg(sql), norm(args)); return r; }

export const all = async (sql, ...args) => (await run_(sql, args)).rows;
export const get = async (sql, ...args) => (await run_(sql, args)).rows[0];
export const run = async (sql, ...args) => ({ changes: (await run_(sql, args)).count });
export const insert = async (sql, ...args) => (await run_(sql + ' RETURNING id', args)).rows[0].id;
export const exec = async (sql) => { await base.exec(sql); };
export const tx = async (fn) => {
  if (als.getStore()) return fn(); // já dentro de uma transação
  return base.tx((t) => als.run(t, fn));
};
export const driver = () => base?.driver;

// Inicializa (uma vez por instância): conecta, cria o esquema e, se o banco estiver vazio, popula.
export function initDb() {
  if (!readyP) readyP = (async () => {
    base = await connect();
    if (process.env.AUTO_MIGRATE !== '0') {
      await base.exec(SCHEMA);
      if (base.driver === 'postgres' && process.env.ENABLE_RLS !== '0') await base.exec(RLS);
      const n = (await get('SELECT COUNT(*) n FROM users')).n;
      if (!n) await seed(process.env.SEED === 'minimal' ? 'minimal' : 'demo');
    }
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

/* ---------- dados iniciais ---------- */
export const TIPOS = [
  { id: 'std', nome: 'Standard Casal · Vista Jardim', cap: 2, tarifa: 260 },
  { id: 'dlx', nome: 'Deluxe Queen · Varanda', cap: 2, tarifa: 320 },
  { id: 'tri', nome: 'Triplo', cap: 3, tarifa: 380 },
  { id: 'fam', nome: 'Quádruplo Família', cap: 4, tarifa: 440 },
];
const QUARTOS = [['01','std'],['02','std'],['03','std'],['04','std'],['05','dlx'],['06','dlx'],['07','dlx'],['08','dlx'],['09','dlx'],['10','tri'],['11','tri'],['12','fam'],['13','fam']];
const SET = 'INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v';

async function seed(mode) {
  await tx(async () => {
    if (base.driver === 'postgres') await run('SELECT pg_advisory_xact_lock(7243)'); // evita seed duplo em cold starts paralelos
    if ((await get('SELECT COUNT(*) n FROM users')).n) return;
    const now = new Date().toISOString(), H = today();
    const cfg = {
      pousada: 'Pousada Bosque Cumbuco', cidade: 'Caucaia',
      pix_chave: 'financeiro@exemplo.com.br', pix_nome: 'Pousada Bosque Cumbuco',
      gateway: mode === 'demo' ? 'demo' : 'producao', sinal_pct: '30', ical_token: randomBytes(12).toString('hex'),
      checkin_hora: '14:00', checkout_hora: '12:00', webhook_token: randomBytes(12).toString('hex'),
    };
    for (const [k, v] of Object.entries(cfg)) await run(SET, k, v);
    for (const t of TIPOS) await run('INSERT INTO tipos(id,nome,cap,tarifa) VALUES(?,?,?,?)', t.id, t.nome, t.cap, t.tarifa);
    for (const [n, t] of QUARTOS) await run('INSERT INTO quartos(num,tipo) VALUES(?,?)', n, t);

    if (mode === 'minimal') { // produção: só o administrador (senha em ADMIN_PASSWORD) e a estrutura
      const pwd = process.env.ADMIN_PASSWORD;
      if (!pwd || pwd.length < 10) throw new Error('Defina ADMIN_PASSWORD (mín. 10 caracteres) para o seed mínimo.');
      await run('INSERT INTO users(nome,usuario,senha,role,criado) VALUES(?,?,?,?,?)', 'Administrador', 'admin', hashPw(pwd), 'admin', now);
      return;
    }
    await run("UPDATE quartos SET status='sujo' WHERE num='02'");
    await run("UPDATE quartos SET status='limpando' WHERE num='09'");
    await run("UPDATE quartos SET status='manutencao', obs='Vazamento no chuveiro — aguardando encanador' WHERE num='13'");

    const pw = hashPw('bosque2026');
    const U = (nome, usuario, role) => insert('INSERT INTO users(nome,usuario,senha,role,criado) VALUES(?,?,?,?,?)', nome, usuario, pw, role, now);
    await U('Proprietário(a)', 'admin', 'admin');
    await U('Recepção', 'recepcao', 'recepcao');
    await U('Governanta', 'governanta', 'governanta');
    const cam = await U('Maria (Camareira)', 'camareira', 'camareira');
    await U('Seu José (Manutenção)', 'manutencao', 'manutencao');
    await U('Financeiro', 'financeiro', 'financeiro');

    const tar = Object.fromEntries(TIPOS.map((t) => [t.id, t.tarifa]));
    const res = (c, n, tel, mail, tp, q, di, dn, st, ad, ch, obs, origem = 'site') =>
      insert(`INSERT INTO reservas(code,nome,tel,mail,tipo,quarto,checkin,checkout,ad,ch,obs,status,origem,total,criado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        c, n, tel, mail, tp, q, addD(H, di), addD(H, di + dn), ad, ch, obs || '', st, origem, dn * tar[tp], addD(H, di - 10));
    const r1 = await res('BC-2611', 'Mariana Albuquerque', '85999990001', 'mariana@email.com', 'dlx', '05', 0, 4, 'confirmada', 2, 0, 'Lua de mel');
    const r2 = await res('BC-2598', 'Carlos Henrique Souza', '11988887777', 'carlos@email.com', 'fam', '12', -2, 5, 'hospedado', 2, 2, 'Leva um cachorro pequeno');
    const r3 = await res('BC-2604', 'Juliana e Pedro Lima', '21977776666', '', 'dlx', '06', -3, 3, 'hospedado', 2, 0, '', 'booking');
    await res('BC-2620', 'Ana Beatriz Rocha', '85988881234', 'ana@email.com', 'std', '01', 3, 3, 'pendente', 2, 0, 'Chegada às 21h');
    await res('BC-2622', 'Thomas Müller', '4915112345678', 'thomas@email.de', 'dlx', '07', 5, 7, 'pendente', 1, 0, 'Kitesurf');
    const r6 = await res('BC-2587', 'Família Nogueira', '85991112222', '', 'tri', '10', -6, 4, 'finalizada', 2, 1, '', 'balcao');
    await res('BC-2615', 'Roberta Campos', '31995554444', 'roberta@email.com', 'std', '04', 8, 2, 'confirmada', 2, 0, '');
    await res('BC-2617', 'Lucas Ferreira', '85996663333', '', 'tri', '11', 1, 3, 'confirmada', 3, 0, '', 'balcao');
    await res('BC-2590', 'Sofia Martins', '11991234567', '', 'std', '03', -1, 1, 'cancelada', 2, 0, '');
    await run('UPDATE reservas SET checkin_em=? WHERE id IN (?,?)', now, r2, r3);

    const P = (r, m, v, ref) => run('INSERT INTO pagamentos(reserva_id,metodo,valor,status,ref,criado) VALUES(?,?,?,?,?,?)', r, m, v, 'pago', ref, now);
    await P(r1, 'pix', 384, 'sinal 30%'); await P(r2, 'cartao', 1100, 'total'); await P(r2, 'pix', 400, 'extras');
    await P(r3, 'booking', 960, 'Booking.com (VCC)'); await P(r6, 'dinheiro', 1520, 'saldo');

    const L = (q, t, st, at) => run('INSERT INTO limpeza(quarto,tipo,status,atribuido,data,criado) VALUES(?,?,?,?,?,?)', q, t, st, at, H, now);
    await L('02', 'saida', 'pendente', cam); await L('09', 'saida', 'em_andamento', cam); await L('05', 'arrumacao', 'pendente', null);

    const tours = [
      ['Buggy nas dunas', 'Passeio de buggy pelas dunas do Cumbuco até as lagoas, com paradas para fotos.', 350, '3 h', 'media/d2.jpg'],
      ['Lagoa do Banana e Parnamirim', 'Esquibunda, redes na água e tempo livre nas lagoas.', 180, '4 h', 'media/d5.jpg'],
      ['Kitesurf & jangada', 'Aula experimental de kitesurf ou passeio de jangada, conforme o vento do dia.', 280, '2 h', 'media/d3.jpg'],
      ['Passeio de bike pelo Cumbuco', 'Roteiro de bicicleta pela vila e pela praia (bike disponível na pousada).', 60, '1,5 h', 'media/d1.jpg'],
      ['Quadriciclo & cavalo', 'Passeios de quadriciclo ou a cavalo pelas dunas com parceiros locais.', 300, '2 h', 'media/d4.jpg'],
    ];
    for (const t of tours) await run('INSERT INTO passeios(nome,descricao,preco,duracao,img,fonte) VALUES(?,?,?,?,?,?)', ...t, 'sugestão — confirmar com a pousada');
    await run('INSERT INTO passeio_reservas(passeio_id,reserva_id,nome,tel,data,pessoas,valor,status,criado) VALUES(1,?,?,?,?,2,700,?,?)', r2, 'Carlos Henrique Souza', '11988887777', addD(H, 1), 'confirmado', now);

    const E = [
      ['Lençol casal', 'Enxoval', 'un', 40, 26, 62], ['Lençol solteiro', 'Enxoval', 'un', 14, 10, 48],
      ['Toalha de banho', 'Enxoval', 'un', 36, 40, 32], ['Toalha de rosto', 'Enxoval', 'un', 44, 30, 15],
      ['Toalha de piscina', 'Enxoval', 'un', 20, 16, 38], ['Sabonete', 'Higiene', 'un', 180, 100, 0.9],
      ['Shampoo 30 ml', 'Higiene', 'un', 90, 60, 1.4], ['Papel higiênico', 'Higiene', 'rolo', 120, 80, 1.1],
      ['Água mineral 500 ml', 'Frigobar', 'un', 150, 80, 1.2], ['Cerveja long neck', 'Frigobar', 'un', 48, 36, 5.5],
      ['Café em pó', 'Café da manhã', 'kg', 6, 4, 38], ['Pão francês', 'Café da manhã', 'un', 200, 120, 0.7],
      ['Cloro granulado', 'Piscina', 'kg', 4, 5, 22], ['Detergente', 'Limpeza', 'L', 12, 6, 4.5],
      ['Desinfetante', 'Limpeza', 'L', 8, 8, 6], ['Lâmpada LED', 'Manutenção', 'un', 15, 6, 9],
    ];
    for (const r of E) await run('INSERT INTO estoque(nome,categoria,unidade,qtd,minimo,custo) VALUES(?,?,?,?,?,?)', ...r);
    // Calendários de demonstração da Booking: caminho "/demo/..." é resolvido internamente (sem HTTP).
    for (const q of ['05', '06', '07']) await run('INSERT INTO ical_feeds(quarto,canal,url) VALUES(?,?,?)', q, 'Booking.com', `/demo/booking/${q}.ics`);
  });
}
