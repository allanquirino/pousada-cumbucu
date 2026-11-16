// Gera a migração do Supabase a partir de src/schema.js:  npm run db:export
import { writeFileSync } from 'node:fs';
import { SCHEMA, RLS } from '../src/schema.js';
const sql = `-- Pousada Bosque Cumbuco — esquema inicial (gerado de src/schema.js)\n${SCHEMA}\n-- RLS ligado e sem políticas: a API pública do Supabase (anon/publishable) não acessa nada.\n-- O app conecta direto ao Postgres (role postgres), que ignora RLS.\n${RLS}\n`;
writeFileSync('supabase/migrations/20260101000000_init.sql', sql);
console.log('supabase/migrations/20260101000000_init.sql gerado');
