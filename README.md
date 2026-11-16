# Pousada Bosque Cumbuco — site + sistema de gestão

Site de reservas (público) e painel administrativo (`/admin`) da pousada, num único servidor Node.js
**sem dependências** (Node ≥ 22.13, banco SQLite embutido).

```bash
npm start          # http://localhost:3000   ·   painel: http://localhost:3000/admin/
npm test           # teste de fumaça (fluxos + permissões)
```

Os dados ficam em `data/pousada.db` (ou `DATA_DIR`). Na primeira execução o banco é criado com **dados de demonstração**.

## Contas de demonstração (senha `bosque2026`)
| Usuário | Função | Acessa |
|---|---|---|
| `admin` | Administrador | tudo, inclusive funcionários, integrações e configurações |
| `recepcao` | Recepção | reservas, check-in/out, quartos, passeios, pagamentos; vê limpeza e estoque |
| `governanta` | Governanta | quartos, limpeza (atribui tarefas), estoque |
| `camareira` | Camareira | só suas tarefas de limpeza e vê status dos quartos |
| `manutencao` | Manutenção | quartos (marcar manutenção), estoque; vê limpeza |
| `financeiro` | Financeiro | painel, reservas (leitura), pagamentos |

A matriz de permissões fica em `src/lib.js` (`PERMS`) e é aplicada **no servidor** em toda rota; o menu só reflete isso.

## O que existe
- **Site**: reserva com disponibilidade real, pagamento do sinal (Pix com QR/copia-e-cola válido; cartão em modo demo), área "Minha reserva" (código + telefone) com pagamento, cancelamento e solicitação de passeios; passeios vêm do catálogo do painel.
- **Reservas** de todas as origens (site, balcão, telefone, WhatsApp, Booking), sem overbooking (considera reservas, bloqueios iCal e quartos em manutenção).
- **Check-in / check-out**: check-in exige quarto limpo e livre; check-out exige saldo quitado e gera tarefa de limpeza + marca o quarto como sujo.
- **Quartos**: livre/ocupado/sujo/em limpeza/manutenção/bloqueado e mapa de 14 dias.
- **Limpeza**: kanban (a fazer / em andamento / concluída); concluir a limpeza de saída libera o quarto; arrumação diária gerada para quartos ocupados.
- **Passeios**: catálogo + agenda.  **Estoque**: saldo, mínimo, entradas/saídas com histórico e alerta de falta.
- **Pagamentos**: por forma de pagamento/mês, confirmação de Pix pendente, estorno.
- **Funcionários**: contas, função, ativar/desativar, troca de senha (scrypt).
- **Booking via iCal**: importa o calendário de cada quarto (a cada 15 min ou manual) e exporta um link por quarto; mostra conflitos.

## Integração Booking.com (iCal)
1. Admin → *Booking / iCal* → copie o link de exportação de cada quarto e cole na Extranet da Booking (*Importar calendário*).
2. Na Extranet copie o link iCal de cada quarto e cadastre em *Importar da Booking*.
O iCal é periódico (15–60 min), não instantâneo; reservas da Booking aparecem como **bloqueio** (sem dados do hóspede). Para tempo real use um Channel Manager ou a API de conectividade da Booking. Em desenvolvimento há 3 feeds de demonstração (quartos 05–07) servidos pelo próprio app em `/demo/booking/NN.ics`, com um conflito proposital.

## Para colocar em produção (pendências)
- **Instagram/passeios**: o Instagram exige login e não pôde ser lido; os passeios cadastrados são *sugestões* (marcadas) a confirmar com o cliente.
- **Pagamento real**: o cartão é simulado (`gateway=demo`) e a chave Pix é de exemplo. Integrar um provedor (Mercado Pago, Stripe, Pagar.me…) para cobrança real e para confirmar o Pix automaticamente via `POST /api/webhooks/pix?token=…`. Nunca armazene dados de cartão.
- Trocar **todas** as senhas e a chave Pix; colocar atrás de **HTTPS** (cookie `Secure` é automático via `X-Forwarded-Proto`); fazer backup de `data/`.
- Hospedagem: precisa de disco persistente (VPS, Railway, Fly.io, Render com disco). Não serve em funções serverless (Vercel) com SQLite.
- Definir `WHATS_NUMERO` em `public/index.html` para a mensagem da reserva já ir pronta no WhatsApp.
- Itens fora desta versão: notificações por e-mail/WhatsApp, emissão fiscal, relatórios avançados, política de cancelamento/reembolso automática, rate limiting nas rotas públicas.
