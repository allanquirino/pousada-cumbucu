// Função serverless da Vercel: toda a API (/api/*) e os calendários iCal (/ical/*, /demo/*) passam por aqui.
// Os arquivos estáticos (site e /admin) são servidos pela CDN a partir de public/.
export { default } from '../server.js';
