// Teste de fumaça: sobe o servidor com banco temporário e exercita os fluxos principais e as permissões.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DATABASE_URL: process.env.TEST_DATABASE_URL || '', PGLITE_MEMORY: '1', DATA_DIR: mkdtempSync(path.join(tmpdir(), 'pousada-')) }, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addD = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };
async function login(usuario) {
  const r = await fetch(B + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usuario, senha: 'bosque2026' }) });
  const ck = r.headers.get('set-cookie').split(';')[0];
  return async (m, u, b) => { const x = await fetch(B + '/api' + u, { method: m, headers: { cookie: ck, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { s: x.status, d: await x.json().catch(() => ({})) }; };
}
try {
  for (let i = 0; i < 60; i++) { try { await fetch(B + '/api/public/config'); break; } catch { await sleep(200); } }
  const adm = await login('admin'), rec = await login('recepcao'), cam = await login('camareira'), fin = await login('financeiro');
  // permissões
  assert.equal((await cam('GET', '/reservas')).s, 403, 'camareira não vê reservas');
  assert.equal((await cam('GET', '/estoque')).s, 403, 'camareira não vê estoque');
  assert.equal((await rec('GET', '/funcionarios')).s, 403, 'recepção não vê funcionários');
  assert.equal((await fin('POST', '/reservas', {})).s, 403, 'financeiro não cria reservas');
  assert.equal((await fin('POST', '/estoque/1/mov', { delta: 1 })).s, 403);
  assert.equal((await fetch(B + '/api/dashboard')).status, 401, 'sem login = 401');
  // reserva pública + overbooking
  const pub = (u, b) => fetch(B + '/api/public' + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, d: await r.json() }));
  const body = { tipo: 'fam', checkin: addD(40), checkout: addD(43), ad: 2, ch: 2, nome: 'Fulano de Tal', tel: '85999998888' };
  assert.equal((await pub('/reservas', body)).s, 200);
  assert.equal((await pub('/reservas', body)).s, 409, 'sem overbooking (quarto 13 está em manutenção)');
  const r1 = await pub('/reservas', { ...body, tipo: 'std', ch: 0 }); assert.equal(r1.s, 200);
  // consulta do hóspede exige código + telefone
  assert.equal((await pub('/reservas/consulta', { code: r1.d.code, tel: '11111111111' })).s, 404);
  assert.equal((await pub('/reservas/consulta', { code: r1.d.code, tel: '85999998888' })).s, 200);
  // Pix gera BR Code e confirmação do sinal confirma a reserva
  const px = await pub('/pagar', { code: r1.d.code, tel: '85999998888', metodo: 'pix', parcial: 'sinal' });
  assert.match(px.d.copiaCola, /^000201.*6304[0-9A-F]{4}$/);
  assert.equal((await pub('/pagar/simular-pix', { code: r1.d.code, tel: '85999998888', ref: px.d.ref })).s, 200);
  const lista = (await rec('GET', '/reservas?q=' + r1.d.code)).d;
  assert.equal(lista[0].status, 'confirmada');
  // check-in bloqueado enquanto o quarto não está limpo / ok quando limpo; check-out gera limpeza
  const id = lista[0].id;
  const q = lista[0].quarto;
  await adm('PUT', '/quartos/' + q, { status: 'sujo', obs: '' });
  assert.equal((await rec('POST', `/reservas/${id}/checkin`, {})).s, 409, 'quarto sujo bloqueia check-in');
  await adm('PUT', '/quartos/' + q, { status: 'limpo', obs: '' });
  assert.equal((await rec('POST', `/reservas/${id}/checkin`, {})).s, 200);
  assert.equal((await rec('POST', `/reservas/${id}/checkout`, {})).s, 409, 'saldo em aberto bloqueia check-out');
  assert.equal((await rec('POST', `/reservas/${id}/pagamentos`, { metodo: 'dinheiro', valor: lista[0].saldo })).s, 200);
  assert.equal((await rec('POST', `/reservas/${id}/checkout`, {})).s, 200);
  const tarefas = (await cam('GET', '/limpeza')).d;
  const t = tarefas.find((x) => x.quarto === q && x.tipo === 'saida'); assert.ok(t, 'check-out criou tarefa de limpeza');
  assert.equal((await cam('PATCH', '/limpeza/' + t.id, { status: 'pronto' })).s, 200);
  assert.equal((await adm('GET', '/quartos')).d.find((x) => x.num === q).status, 'limpo', 'limpeza concluída libera o quarto');
  // estoque
  assert.equal((await adm('POST', '/estoque/1/mov', { delta: -9999 })).s, 400, 'saldo não pode ficar negativo');
  // iCal: exporta reservas diretas, importa bloqueios
  const ic = (await adm('GET', '/ical')).d; const ics = await (await fetch(ic.todos)).text(); assert.match(ics, /BEGIN:VCALENDAR/);
  assert.equal((await fetch(B + '/ical/todos.ics?t=errado')).status, 401);
  // gerente: edita descrição das acomodações e gerencia equipe, mas não cria administradores
  const ger = await login('gerente');
  const txt = 'Descrição de teste do quarto Standard.';
  assert.equal((await ger('PUT', '/config', { tipos: [{ id: 'std', tarifa: 270, descricao: txt }] })).s, 200);
  const cfgPub = await (await fetch(B + '/api/public/config')).json();
  assert.equal(cfgPub.tipos.find((t) => t.id === 'std').descricao, txt, 'descrição aparece no site');
  assert.equal(cfgPub.tipos.find((t) => t.id === 'std').tarifa, 270);
  assert.equal((await rec('PUT', '/config', { tipos: [] })).s, 403, 'recepção não edita configurações');
  assert.equal((await ger('POST', '/funcionarios', { nome: 'Novo Admin', usuario: 'novoadmin', senha: '12345678', role: 'admin' })).s, 403);
  assert.equal((await ger('POST', '/funcionarios', { nome: 'Nova Recep', usuario: 'novarecep', senha: '12345678', role: 'recepcao' })).s, 200);
  const adminId = (await adm('GET', '/funcionarios')).d.find((u) => u.usuario === 'admin').id;
  assert.equal((await ger('PUT', '/funcionarios/' + adminId, { senha: 'novasenha123' })).s, 403, 'gerente não mexe na conta do administrador');
  // varredura: toda tela de leitura do painel responde e traz os campos esperados
  const cfg = (await adm('GET', '/config')).d;
  assert.ok(cfg.pix_chave && cfg.pousada && cfg.sinal_pct, 'configurações carregam (chave Pix, nome, sinal)');
  assert.equal(cfg.ical_token, undefined, 'token do iCal não vai para a tela');
  const det = (await adm('GET', '/reservas/' + id)).d;
  assert.ok(det.code && det.nome && typeof det.saldo === 'number' && Array.isArray(det.pagamentos), 'detalhe da reserva completo');
  for (const u of ['/dashboard', '/reservas', '/quartos', '/mapa', '/limpeza', '/equipe-limpeza', '/passeios', '/passeios/reservas', '/estoque', '/estoque/1/mov', '/pagamentos', '/funcionarios', '/perfis', '/ical', '/config', '/me'])
    assert.equal((await adm('GET', u)).s, 200, 'GET ' + u);
  // fotos das acomodações: upload, limite de 10, ordem, formato e permissão
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString('base64');
  let fotos = (await ger('GET', '/acomodacoes/dlx/fotos')).d.fotos; assert.equal(fotos.length, 2, 'duas fotos padrão por tipo');
  const up = await ger('POST', '/acomodacoes/dlx/fotos', { dados: jpg }); assert.equal(up.s, 200);
  const pubT = (await (await fetch(B + '/api/public/config')).json()).tipos.find((t) => t.id === 'dlx');
  assert.equal(pubT.fotos.length, 3); assert.equal(pubT.fotos[2], `/api/fotos/${up.d.id}`, 'foto enviada aparece no site');
  const img = await fetch(B + `/api/fotos/${up.d.id}`); assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await img.arrayBuffer()).toString('base64'), jpg, 'bytes idênticos');
  assert.equal((await ger('POST', '/acomodacoes/dlx/fotos', { dados: Buffer.from('<svg onload=alert(1)>xxxxxxxxxxxxxxxxxxxx').toString('base64') })).s, 415, 'SVG/HTML recusado');
  assert.equal((await rec('POST', '/acomodacoes/dlx/fotos', { dados: jpg })).s, 403, 'recepção não envia fotos');
  for (let i = 0; i < 7; i++) assert.equal((await ger('POST', '/acomodacoes/dlx/fotos', { dados: jpg })).s, 200);
  assert.equal((await ger('POST', '/acomodacoes/dlx/fotos', { dados: jpg })).s, 409, 'máximo de 10 fotos por tipo');
  fotos = (await ger('GET', '/acomodacoes/dlx/fotos')).d.fotos; assert.equal(fotos.length, 10);
  const ids = fotos.map((f) => f.id).reverse();
  assert.equal((await ger('PUT', '/acomodacoes/dlx/fotos/ordem', { ids })).s, 200);
  assert.equal((await ger('GET', '/acomodacoes/dlx/fotos')).d.fotos[0].id, ids[0], 'ordem salva (primeira = capa)');
  assert.equal((await ger('DELETE', '/fotos/' + ids[0])).s, 200);
  assert.equal((await ger('GET', '/acomodacoes/dlx/fotos')).d.fotos.length, 9);
  console.log('OK — todos os testes passaram');
} catch (e) { console.error('FALHOU:', e.message); process.exitCode = 1; }
finally { srv.kill(); }
