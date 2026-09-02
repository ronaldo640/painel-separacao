// Vercel Serverless Function — sincroniza itens de pedidos da API v2 do Tiny ERP
// (Olist) direto para o banco Neon (tabela picking_records).
//
// Os tokens NUNCA passam pelo navegador: ficam só como variáveis de ambiente
// do projeto na Vercel (TINY_TOKEN_SP, TINY_TOKEN_SUL, TINY_TOKEN_TRADE —
// os mesmos nomes usados no painel de expedição).
//
// Diferente do painel de expedição (que lê direto de notas.fiscais.pesquisa,
// 1 chamada por página), aqui a granularidade é por ITEM/SKU dentro de cada
// pedido, e a busca de pedidos não retorna os itens — é preciso 1 chamada
// extra (pedido.obter.php) por pedido. Isso deixa a sincronização bem mais
// pesada em número de chamadas à API do Tiny, então:
//   - a janela padrão (sem dataInicial/dataFinal) é de poucos dias, não 60;
//   - cada execução processa no máximo MAX_PEDIDOS_POR_FILIAL pedidos;
//   - os detalhes são buscados com concorrência limitada, não um por vez
//     nem todos de uma vez.
// Para preencher histórico maior, chame com ?filial=SP&dataInicial=...&dataFinal=...
// em janelas menores (ex: um mês por vez), do mesmo jeito feito no painel de
// expedição.

import { neon } from '@neondatabase/serverless';
import { ensurePickingTable, insertPickingRows } from './picking.js';

const TINY_PEDIDOS_URL = 'https://api.tiny.com.br/api2/pedidos.pesquisa.php';
const TINY_PEDIDO_DETALHE_URL = 'https://api.tiny.com.br/api2/pedido.obter.php';
const MAX_PAGES = 30; // páginas da busca de pedidos por filial
const MAX_PEDIDOS_POR_FILIAL = 400; // protege contra timeout/estouro de cota numa única execução
const DETAIL_CONCURRENCY = 6; // chamadas pedido.obter.php simultâneas por filial
const LOOKBACK_DAYS = 7; // janela padrão da sincronização de rotina (histórico maior = manual)

const TINY_FILIAIS = [
  { key: 'SP', nome: 'PAULICOMP SP', env: 'TINY_TOKEN_SP' },
  { key: 'SUL', nome: 'PAULICOMP SUL', env: 'TINY_TOKEN_SUL' },
  { key: 'TRADE', nome: 'COMP TRADE', env: 'TINY_TOKEN_TRADE' },
];

function toBrDate(date) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

function toIsoDate(brDate) {
  if (!brDate || typeof brDate !== 'string' || !brDate.includes('/')) return null;
  const [d, m, y] = brDate.split('/');
  if (!d || !m || !y) return null;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

async function listPedidoIds(token, dataInicial, dataFinal) {
  const ids = [];
  let pagina = 1;
  let totalPaginas = 1;

  do {
    const params = new URLSearchParams({ token, formato: 'json', pagina: String(pagina), dataInicial, dataFinal });
    const resp = await fetch(`${TINY_PEDIDOS_URL}?${params.toString()}`);
    const json = await resp.json();
    const retorno = json.retorno || {};

    if (retorno.status === 'Erro' || retorno.status === 'erro') {
      const msg = (retorno.erros || []).map(e => e.erro).join('; ') || 'Erro desconhecido na busca de pedidos.';
      throw new Error(msg);
    }

    totalPaginas = Number(retorno.numero_paginas || 1);
    (retorno.pedidos || []).forEach(p => ids.push(p.pedido.id));
    pagina++;
  } while (pagina <= totalPaginas && pagina <= MAX_PAGES);

  return { ids, totalPaginas };
}

async function fetchPedidoDetalhe(token, id) {
  const params = new URLSearchParams({ token, formato: 'json', id: String(id) });
  const resp = await fetch(`${TINY_PEDIDO_DETALHE_URL}?${params.toString()}`);
  const json = await resp.json();
  const retorno = json.retorno || {};
  if (retorno.status === 'Erro' || retorno.status === 'erro') {
    const msg = (retorno.erros || []).map(e => e.erro).join('; ') || 'Erro ao obter pedido.';
    throw new Error(msg);
  }
  return retorno.pedido;
}

function mapPedidoParaItens(pedido, filialNome) {
  if (!pedido) return [];
  const situacaoTexto = (pedido.situacao || '').toLowerCase();
  if (situacaoTexto.includes('cancelad')) return [];

  const dataIso = toIsoDate(pedido.data_pedido);
  if (!dataIso) return [];

  return (pedido.itens || []).map(entry => {
    const item = entry.item || {};
    return {
      filial: filialNome,
      data: dataIso,
      data_fmt: pedido.data_pedido,
      pedido: String(pedido.numero || pedido.id),
      sku: String(item.codigo || '-').trim(),
      produto: item.descricao || '-',
      qtd: Number(item.quantidade) || 1,
    };
  });
}

// Roda `worker` sobre `items` com no máximo `limit` chamadas simultâneas.
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runNext() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Método não permitido.' });
  }

  const query = req.method === 'GET' ? req.query : (req.body || {});
  let dataInicial = query.dataInicial || null;
  let dataFinal = query.dataFinal || null;
  if (!dataInicial || !dataFinal) {
    const hoje = new Date();
    const inicio = new Date(hoje.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    dataFinal = dataFinal || toBrDate(hoje);
    dataInicial = dataInicial || toBrDate(inicio);
  }

  const filialFiltro = query.filial ? String(query.filial).toUpperCase() : null;
  const filiaisAtivas = TINY_FILIAIS.filter(f => process.env[f.env] && (!filialFiltro || f.key === filialFiltro));
  if (filiaisAtivas.length === 0) {
    return res.status(200).json({
      ok: true,
      results: [],
      insertedTotal: 0,
      warning: filialFiltro
        ? `Token não configurado para a filial "${filialFiltro}".`
        : 'Nenhum token do Tiny configurado nas variáveis de ambiente da Vercel (TINY_TOKEN_SP / TINY_TOKEN_SUL / TINY_TOKEN_TRADE).',
    });
  }

  const sql = neon(process.env.DATABASE_URL);
  try {
    await ensurePickingTable(sql);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Erro ao preparar tabela: ' + e.message });
  }

  const results = await Promise.all(filiaisAtivas.map(async f => {
    const token = process.env[f.env];
    try {
      const { ids, totalPaginas } = await listPedidoIds(token, dataInicial, dataFinal);
      const truncado = ids.length > MAX_PEDIDOS_POR_FILIAL;
      const idsProcessados = ids.slice(0, MAX_PEDIDOS_POR_FILIAL);

      let falhas = 0;
      let ultimoErroDetalhe = null;
      const pedidos = await mapWithConcurrency(idsProcessados, DETAIL_CONCURRENCY, id =>
        fetchPedidoDetalhe(token, id).catch(err => {
          falhas++;
          ultimoErroDetalhe = err.message;
          return null;
        })
      );

      const rows = pedidos.flatMap(p => mapPedidoParaItens(p, f.nome));
      const inserted = await insertPickingRows(sql, rows);

      return {
        filial: f.nome,
        pedidosEncontrados: ids.length,
        pedidosProcessados: idsProcessados.length,
        pedidosComFalha: falhas,
        erroDetalhe: falhas > 0 ? ultimoErroDetalhe : undefined,
        itensLidos: rows.length,
        inseridos: inserted,
        truncado,
      };
    } catch (err) {
      return { filial: f.nome, error: err.message };
    }
  }));

  const insertedTotal = results.reduce((sum, r) => sum + (r.inseridos || 0), 0);
  res.status(200).json({ ok: true, dataInicial, dataFinal, results, insertedTotal });
}
