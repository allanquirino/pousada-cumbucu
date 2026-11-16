// Esquema PostgreSQL (Supabase). Fonte única: `npm run db:export` gera supabase/migrations/*.sql a partir daqui.
export const TABLES = ['settings', 'users', 'sessions', 'tipos', 'quartos', 'reservas', 'pagamentos', 'limpeza', 'passeios', 'passeio_reservas', 'estoque', 'estoque_mov', 'ical_feeds', 'ical_blocos', 'fotos'];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, nome TEXT NOT NULL, usuario TEXT NOT NULL UNIQUE, senha TEXT NOT NULL,
  role TEXT NOT NULL, ativo INTEGER NOT NULL DEFAULT 1, criado TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expira BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS tipos (id TEXT PRIMARY KEY, nome TEXT, cap INTEGER, tarifa DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS quartos (num TEXT PRIMARY KEY, tipo TEXT NOT NULL REFERENCES tipos(id), status TEXT NOT NULL DEFAULT 'limpo', obs TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS reservas (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE, nome TEXT, tel TEXT, mail TEXT, tipo TEXT, quarto TEXT,
  checkin TEXT, checkout TEXT, ad INTEGER, ch INTEGER, obs TEXT DEFAULT '', status TEXT, origem TEXT DEFAULT 'site',
  total DOUBLE PRECISION DEFAULT 0, criado TEXT, checkin_em TEXT, checkout_em TEXT);
CREATE INDEX IF NOT EXISTS ix_res_datas ON reservas(checkin, checkout);
CREATE INDEX IF NOT EXISTS ix_res_quarto ON reservas(quarto, status);
CREATE TABLE IF NOT EXISTS pagamentos (
  id SERIAL PRIMARY KEY, reserva_id INTEGER NOT NULL REFERENCES reservas(id) ON DELETE CASCADE, metodo TEXT, valor DOUBLE PRECISION, status TEXT, ref TEXT, obs TEXT DEFAULT '', criado TEXT, user_id INTEGER);
CREATE INDEX IF NOT EXISTS ix_pag_reserva ON pagamentos(reserva_id);
CREATE TABLE IF NOT EXISTS limpeza (
  id SERIAL PRIMARY KEY, quarto TEXT, tipo TEXT, status TEXT DEFAULT 'pendente', atribuido INTEGER, data TEXT,
  notas TEXT DEFAULT '', criado TEXT, iniciado TEXT, concluido TEXT);
CREATE TABLE IF NOT EXISTS passeios (id SERIAL PRIMARY KEY, nome TEXT, descricao TEXT, preco DOUBLE PRECISION, duracao TEXT, img TEXT, ativo INTEGER DEFAULT 1, fonte TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS passeio_reservas (
  id SERIAL PRIMARY KEY, passeio_id INTEGER, reserva_id INTEGER, nome TEXT, tel TEXT, data TEXT, pessoas INTEGER, valor DOUBLE PRECISION, status TEXT DEFAULT 'solicitado', criado TEXT);
CREATE TABLE IF NOT EXISTS estoque (id SERIAL PRIMARY KEY, nome TEXT, categoria TEXT, unidade TEXT, qtd DOUBLE PRECISION DEFAULT 0, minimo DOUBLE PRECISION DEFAULT 0, custo DOUBLE PRECISION DEFAULT 0);
CREATE TABLE IF NOT EXISTS estoque_mov (id SERIAL PRIMARY KEY, item_id INTEGER, delta DOUBLE PRECISION, motivo TEXT, user_id INTEGER, criado TEXT);
CREATE TABLE IF NOT EXISTS ical_feeds (
  id SERIAL PRIMARY KEY, quarto TEXT, canal TEXT, url TEXT, ativo INTEGER DEFAULT 1, ultimo_sync TEXT, ultimo_status TEXT, conflitos INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ical_blocos (id SERIAL PRIMARY KEY, feed_id INTEGER, uid TEXT, quarto TEXT, checkin TEXT, checkout TEXT, resumo TEXT);
CREATE INDEX IF NOT EXISTS ix_blocos ON ical_blocos(quarto, checkin, checkout);
ALTER TABLE tipos ADD COLUMN IF NOT EXISTS descricao TEXT DEFAULT '';
CREATE TABLE IF NOT EXISTS fotos (
  id SERIAL PRIMARY KEY, tipo TEXT NOT NULL REFERENCES tipos(id) ON DELETE CASCADE, ordem INTEGER DEFAULT 0,
  url TEXT, mime TEXT, dados BYTEA, legenda TEXT DEFAULT '', criado TEXT);
CREATE INDEX IF NOT EXISTS ix_fotos_tipo ON fotos(tipo, ordem);
`;

// Segurança no Supabase: o app acessa o banco direto (role postgres, ignora RLS). Ativar RLS sem políticas
// garante que a API pública do Supabase (chave anon/publishable) NÃO consiga ler nem gravar nada.
export const RLS = TABLES.map((t) => `ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`).join('\n');
