// Utilidades: permissões, Pix (BR Code) e iCal.

/* ---------- Níveis de acesso por função ----------
   'w' = ler e alterar · 'r' = somente ler · 'own' = só as próprias tarefas */
export const PERMS = {
  admin:      { dashboard: 'w', reservas: 'w', checkin: 'w', quartos: 'w', limpeza: 'w', passeios: 'w', estoque: 'w', pagamentos: 'w', funcionarios: 'w', integracoes: 'w', config: 'w' },
  recepcao:   { dashboard: 'r', reservas: 'w', checkin: 'w', quartos: 'w', limpeza: 'r', passeios: 'w', estoque: 'r', pagamentos: 'w' },
  governanta: { dashboard: 'r', quartos: 'w', limpeza: 'w', estoque: 'w' },
  camareira:  { limpeza: 'own', quartos: 'r' },
  manutencao: { quartos: 'w', estoque: 'w', limpeza: 'r' },
  financeiro: { dashboard: 'r', reservas: 'r', pagamentos: 'w' },
};
export const ROLE_LABEL = { admin: 'Administrador', recepcao: 'Recepção', governanta: 'Governanta', camareira: 'Camareira', manutencao: 'Manutenção', financeiro: 'Financeiro' };
export const perm = (role, mod) => PERMS[role]?.[mod] || null;

/* ---------- Pix: BR Code estático (EMV) ---------- */
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
const noAccent = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '');
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
export function pixPayload({ chave, nome, cidade, valor, txid }) {
  const mai = tlv('00', 'BR.GOV.BCB.PIX') + tlv('01', chave);
  const p = tlv('00', '01') + tlv('26', mai) + tlv('52', '0000') + tlv('53', '986') +
    (valor ? tlv('54', Number(valor).toFixed(2)) : '') + tlv('58', 'BR') +
    tlv('59', noAccent(nome).slice(0, 25) || 'POUSADA') + tlv('60', noAccent(cidade).slice(0, 15) || 'CUMBUCO') +
    tlv('62', tlv('05', noAccent(txid).replace(/ /g, '').slice(0, 25) || '***')) + '6304';
  return p + crc16(p);
}

/* ---------- iCal ---------- */
const d8 = (iso) => iso.replaceAll('-', '');
const esc = (s) => String(s).replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
export function buildIcs(nome, events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Pousada Bosque Cumbuco//Reservas//PT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + esc(nome)];
  for (const e of events) {
    L.push('BEGIN:VEVENT', 'UID:' + e.uid, 'DTSTAMP:' + stamp, 'DTSTART;VALUE=DATE:' + d8(e.checkin), 'DTEND;VALUE=DATE:' + d8(e.checkout),
      'SUMMARY:' + esc(e.resumo || 'Reservado'), 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}
const toIso = (v) => { const m = /(\d{4})(\d{2})(\d{2})/.exec(v || ''); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
export function parseIcs(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const out = []; let cur = null;
  for (const ln of lines) {
    if (ln === 'BEGIN:VEVENT') cur = {};
    else if (ln === 'END:VEVENT') { if (cur?.checkin && cur?.checkout && cur.checkout > cur.checkin) out.push(cur); cur = null; }
    else if (cur) {
      const i = ln.indexOf(':'); if (i < 0) continue;
      const key = ln.slice(0, i).split(';')[0].toUpperCase(); const val = ln.slice(i + 1);
      if (key === 'UID') cur.uid = val;
      else if (key === 'DTSTART') cur.checkin = toIso(val);
      else if (key === 'DTEND') cur.checkout = toIso(val);
      else if (key === 'SUMMARY') cur.resumo = val.replace(/\\([,;\\])/g, '$1').slice(0, 120);
    }
  }
  return out.map((e, k) => ({ ...e, uid: e.uid || `evt-${k}-${e.checkin}` }));
}
