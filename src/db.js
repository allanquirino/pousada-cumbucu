// Banco de dados (SQLite nativo do Node 22) + dados de demonstração.
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

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

export const TIPOS = [
  { id: 'std', nome: 'Standard Casal · Vista Jardim', cap: 2, tarifa: 260 },
  { id: 'dlx', nome: 'Deluxe Queen · Varanda', cap: 2, tarifa: 320 },
  { id: 'tri', nome: 'Triplo', cap: 3, tarifa: 380 },
  { id: 'fam', nome: 'Quádruplo Família', cap: 4, tarifa: 440 },
];
const QUARTOS = [['01','std'],['02','std'],['03','std'],['04','std'],['05','dlx'],['06','dlx'],['07','dlx'],['08','dlx'],['09','dlx'],['10','tri'],['11','tri'],['12','fam'],['13','fam']];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, nome TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE, senha TEXT NOT NULL,
  role TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expira INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS tipos (id TEXT PRIMARY KEY, nome TEXT, cap INTEGER, tarifa REAL);
CREATE TABLE IF NOT EXISTS quartos (num TEXT PRIMARY KEY, tipo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'limpo', obs TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY, code TEXT UNIQUE, nome TEXT, tel TEXT, mail TEXT, tipo TEXT, quarto TEXT,
  checkin TEXT, checkout TEXT, ad INTEGER, ch INTEGER, obs TEXT DEFAULT '', status TEXT, origem TEXT DEFAULT 'site',
  total REAL DEFAULT 0, criado TEXT, checkin_em TEXT, checkout_em TEXT);
CREATE INDEX IF NOT EXISTS ix_res_datas ON reservas(checkin, checkout);
CREATE TABLE IF NOT EXISTS pagamentos (
  id INTEGER PRIMARY KEY, reserva_id INTEGER NOT NULL, metodo TEXT, valor REAL, status TEXT, ref TEXT, obs TEXT DEFAULT '', criado TEXT, user_id INTEGER);
CREATE TABLE IF NOT EXISTS limpeza (
  id INTEGER PRIMARY KEY, quarto TEXT, tipo TEXT, status TEXT DEFAULT 'pendente', atribuido INTEGER, data TEXT,
  notas TEXT DEFAULT '', criado TEXT, iniciado TEXT, concluido TEXT);
CREATE TABLE IF NOT EXISTS passeios (id INTEGER PRIMARY KEY, nome TEXT, descricao TEXT, preco REAL, duracao TEXT, img TEXT, ativo INTEGER DEFAULT 1, fonte TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS passeio_reservas (
  id INTEGER PRIMARY KEY, passeio_id INTEGER, reserva_id INTEGER, nome TEXT, tel TEXT, data TEXT, pessoas INTEGER, valor REAL, status TEXT DEFAULT 'solicitado', criado TEXT);
CREATE TABLE IF NOT EXISTS estoque (id INTEGER PRIMARY KEY, nome TEXT, categoria TEXT, unidade TEXT, qtd REAL DEFAULT 0, minimo REAL DEFAULT 0, custo REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS estoque_mov (id INTEGER PRIMARY KEY, item_id INTEGER, delta REAL, motivo TEXT, user_id INTEGER, criado TEXT);
CREATE TABLE IF NOT EXISTS ical_feeds (
  id INTEGER PRIMARY KEY, quarto TEXT, canal TEXT, url TEXT, ativo INTEGER DEFAULT 1, ultimo_sync TEXT, ultimo_status TEXT, conflitos INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ical_blocos (id INTEGER PRIMARY KEY, feed_id INTEGER, uid TEXT, quarto TEXT, checkin TEXT, checkout TEXT, resumo TEXT);
CREATE INDEX IF NOT EXISTS ix_blocos ON ical_blocos(quarto, checkin, checkout);
`;

export function openDb(dir = process.env.DATA_DIR || './data') {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'pousada.db'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  const has = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (!has) seed(db);
  return db;
}

function seed(db) {
  const now = new Date().toISOString();
  const H = today();
  const set = db.prepare('INSERT OR REPLACE INTO settings(k,v) VALUES(?,?)');
  const cfg = {
    pousada: 'Pousada Bosque Cumbuco', cidade: 'Caucaia',
    pix_chave: 'financeiro@exemplo.com.br', pix_nome: 'Pousada Bosque Cumbuco',
    gateway: 'demo', sinal_pct: '30', ical_token: randomBytes(12).toString('hex'),
    checkin_hora: '14:00', checkout_hora: '12:00', webhook_token: randomBytes(12).toString('hex'),
  };
  for (const [k, v] of Object.entries(cfg)) set.run(k, v);

  for (const t of TIPOS) db.prepare('INSERT INTO tipos VALUES(?,?,?,?)').run(t.id, t.nome, t.cap, t.tarifa);
  for (const [n, t] of QUARTOS) db.prepare('INSERT INTO quartos(num,tipo) VALUES(?,?)').run(n, t);
  db.prepare("UPDATE quartos SET status='sujo' WHERE num='02'").run();
  db.prepare("UPDATE quartos SET status='limpando' WHERE num='09'").run();
  db.prepare("UPDATE quartos SET status='manutencao', obs='Vazamento no chuveiro — aguardando encanador' WHERE num='13'").run();

  const pw = hashPw('bosque2026');
  const U = (nome, usuario, role) => db.prepare('INSERT INTO users(nome,usuario,senha,role,criado) VALUES(?,?,?,?,?)').run(nome, usuario, pw, role, now).lastInsertRowid;
  U('Proprietário(a)', 'admin', 'admin');
  U('Recepção', 'recepcao', 'recepcao');
  U('Governanta', 'governanta', 'governanta');
  const cam = U('Maria (Camareira)', 'camareira', 'camareira');
  U('Seu José (Manutenção)', 'manutencao', 'manutencao');
  U('Financeiro', 'financeiro', 'financeiro');

  const R = db.prepare(`INSERT INTO reservas(code,nome,tel,mail,tipo,quarto,checkin,checkout,ad,ch,obs,status,origem,total,criado) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const tar = Object.fromEntries(TIPOS.map((t) => [t.id, t.tarifa]));
  const res = (c, n, tel, mail, tp, q, di, dn, st, ad, ch, obs, origem = 'site') =>
    R.run(c, n, tel, mail, tp, q, addD(H, di), addD(H, di + dn), ad, ch, obs || '', st, origem, dn * tar[tp], addD(H, di - 10)).lastInsertRowid;
  const r1 = res('BC-2611', 'Mariana Albuquerque', '85999990001', 'mariana@email.com', 'dlx', '05', 0, 4, 'confirmada', 2, 0, 'Lua de mel');
  const r2 = res('BC-2598', 'Carlos Henrique Souza', '11988887777', 'carlos@email.com', 'fam', '12', -2, 5, 'hospedado', 2, 2, 'Leva um cachorro pequeno');
  const r3 = res('BC-2604', 'Juliana e Pedro Lima', '21977776666', '', 'dlx', '06', -3, 3, 'hospedado', 2, 0, '', 'booking');
  res('BC-2620', 'Ana Beatriz Rocha', '85988881234', 'ana@email.com', 'std', '01', 3, 3, 'pendente', 2, 0, 'Chegada às 21h');
  res('BC-2622', 'Thomas Müller', '4915112345678', 'thomas@email.de', 'dlx', '07', 5, 7, 'pendente', 1, 0, 'Kitesurf');
  const r6 = res('BC-2587', 'Família Nogueira', '85991112222', '', 'tri', '10', -6, 4, 'finalizada', 2, 1, '', 'balcao');
  res('BC-2615', 'Roberta Campos', '31995554444', 'roberta@email.com', 'std', '04', 8, 2, 'confirmada', 2, 0, '');
  res('BC-2617', 'Lucas Ferreira', '85996663333', '', 'tri', '11', 1, 3, 'confirmada', 3, 0, '', 'balcao');
  res('BC-2590', 'Sofia Martins', '11991234567', '', 'std', '03', -1, 1, 'cancelada', 2, 0, '');
  db.prepare('UPDATE reservas SET checkin_em=? WHERE id IN (?,?)').run(now, r2, r3);

  const P = db.prepare('INSERT INTO pagamentos(reserva_id,metodo,valor,status,ref,criado) VALUES(?,?,?,?,?,?)');
  P.run(r1, 'pix', 384, 'pago', 'sinal 30%', now);
  P.run(r2, 'cartao', 1100, 'pago', 'total', now);
  P.run(r2, 'pix', 400, 'pago', 'extras', now);
  P.run(r3, 'booking', 960, 'pago', 'Booking.com (VCC)', now);
  P.run(r6, 'dinheiro', 1520, 'pago', 'saldo', now);

  const L = db.prepare('INSERT INTO limpeza(quarto,tipo,status,atribuido,data,criado) VALUES(?,?,?,?,?,?)');
  L.run('02', 'saida', 'pendente', cam, H, now);
  L.run('09', 'saida', 'em_andamento', cam, H, now);
  L.run('05', 'arrumacao', 'pendente', null, H, now);

  const T = db.prepare('INSERT INTO passeios(nome,descricao,preco,duracao,img,fonte) VALUES(?,?,?,?,?,?)');
  const tours = [
    ['Buggy nas dunas', 'Passeio de buggy pelas dunas do Cumbuco até as lagoas, com paradas para fotos.', 350, '3 h', 'media/d2.jpg'],
    ['Lagoa do Banana e Parnamirim', 'Esquibunda, redes na água e tempo livre nas lagoas.', 180, '4 h', 'media/d5.jpg'],
    ['Kitesurf & jangada', 'Aula experimental de kitesurf ou passeio de jangada, conforme o vento do dia.', 280, '2 h', 'media/d3.jpg'],
    ['Passeio de bike pelo Cumbuco', 'Roteiro de bicicleta pela vila e pela praia (bike disponível na pousada).', 60, '1,5 h', 'media/d1.jpg'],
    ['Quadriciclo & cavalo', 'Passeios de quadriciclo ou a cavalo pelas dunas com parceiros locais.', 300, '2 h', 'media/d4.jpg'],
  ];
  for (const t of tours) T.run(...t, 'sugestão — confirmar com a pousada');
  db.prepare('INSERT INTO passeio_reservas(passeio_id,reserva_id,nome,tel,data,pessoas,valor,status,criado) VALUES(1,?,?,?,?,2,700,?,?)')
    .run(r2, 'Carlos Henrique Souza', '11988887777', addD(H, 1), 'confirmado', now);

  const E = db.prepare('INSERT INTO estoque(nome,categoria,unidade,qtd,minimo,custo) VALUES(?,?,?,?,?,?)');
  [
    ['Lençol casal', 'Enxoval', 'un', 40, 26, 62], ['Lençol solteiro', 'Enxoval', 'un', 14, 10, 48],
    ['Toalha de banho', 'Enxoval', 'un', 36, 40, 32], ['Toalha de rosto', 'Enxoval', 'un', 44, 30, 15],
    ['Toalha de piscina', 'Enxoval', 'un', 20, 16, 38], ['Sabonete', 'Higiene', 'un', 180, 100, 0.9],
    ['Shampoo 30 ml', 'Higiene', 'un', 90, 60, 1.4], ['Papel higiênico', 'Higiene', 'rolo', 120, 80, 1.1],
    ['Água mineral 500 ml', 'Frigobar', 'un', 150, 80, 1.2], ['Cerveja long neck', 'Frigobar', 'un', 48, 36, 5.5],
    ['Café em pó', 'Café da manhã', 'kg', 6, 4, 38], ['Pão francês', 'Café da manhã', 'un', 200, 120, 0.7],
    ['Cloro granulado', 'Piscina', 'kg', 4, 5, 22], ['Detergente', 'Limpeza', 'L', 12, 6, 4.5],
    ['Desinfetante', 'Limpeza', 'L', 8, 8, 6], ['Lâmpada LED', 'Manutenção', 'un', 15, 6, 9],
  ].forEach((r) => E.run(...r));

  const F = db.prepare('INSERT INTO ical_feeds(quarto,canal,url) VALUES(?,?,?)');
  const base = `http://127.0.0.1:${process.env.PORT || 3000}`;
  for (const q of ['05', '06', '07']) F.run(q, 'Booking.com', `${base}/demo/booking/${q}.ics`);
}
