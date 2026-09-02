# Painel Paulicomp — Separação, Picking & Curva ABC

Dashboard executivo estático (HTML + Tailwind + Chart.js), com sincronização
automática de itens de pedidos direto do Tiny ERP (Olist).

## Deploy na Vercel

1. Suba este repositório para o GitHub/GitLab.
2. Na Vercel, importe o repositório (Framework preset: **Other**).
3. Configure as variáveis de ambiente abaixo em **Project → Settings →
   Environment Variables**.
4. Deploy.

## Variáveis de ambiente necessárias

- `DATABASE_URL` — string de conexão do Neon (mesmo banco/projeto do painel
  de expedição, ou um Neon separado — qualquer um funciona, a tabela
  `picking_records` é criada automaticamente na primeira chamada).
- `TINY_TOKEN_SP`, `TINY_TOKEN_SUL`, `TINY_TOKEN_TRADE` — os mesmos tokens
  usados no painel de expedição (API v2 do Tiny, um por filial).

## Como funciona a sincronização

Diferente do painel de expedição (que lê a lista de notas fiscais direto),
aqui a granularidade é por **item dentro do pedido** (SKU + quantidade), e a
API do Tiny não retorna os itens na busca de pedidos — é preciso 1 chamada
extra (`pedido.obter.php`) por pedido encontrado. Por isso:

- A sincronização de rotina (botão **Sincronizar Tiny/Olist**, o auto-sync a
  cada 30 min e o Cron diário) cobre só os **últimos 3 dias** por padrão, com
  no máximo 100 pedidos por filial por execução — uma janela ou volume maior
  arriscaria estourar o tempo máximo da função. As chamadas de detalhe do
  pedido são feitas uma por vez (com pequenas pausas e novas tentativas
  automáticas), porque o Tiny bloqueia temporariamente quando recebe muitas
  chamadas em sequência rápida.
- Para preencher histórico maior, chame `/api/tiny-sync` manualmente com
  `?filial=SP&dataInicial=01/01/2025&dataFinal=31/01/2025` (um mês por vez,
  por filial), do mesmo jeito feito no painel de expedição.

## Arquivos

- `index.html` — aplicação completa (single-file).
- `api/picking.js` — GET/POST/DELETE na tabela `picking_records` do Neon
  (dedup por `filial + pedido + sku`).
- `api/tiny-sync.js` — busca pedidos e itens no Tiny e grava no Neon.
- `vercel.json` — `maxDuration: 60` na função de sync + Cron diário.
