import { neon } from '@neondatabase/serverless';

const COLS = ['filial', 'data', 'data_fmt', 'pedido', 'sku', 'produto', 'qtd'];
const INSERT_CHUNK_SIZE = 300;

export async function insertPickingRows(sql, rows) {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
        const params = [];
        const values = chunk.map((r, idx) => {
            const base = idx * COLS.length;
            params.push(
                r.filial || '-', r.data || '', r.data_fmt || '-', r.pedido || '-',
                r.sku || '-', r.produto || '-', Number(r.qtd) || 1,
            );
            return `(${COLS.map((_, c) => `$${base + c + 1}`).join(', ')})`;
        }).join(', ');

        const text = `
            INSERT INTO picking_records (${COLS.join(', ')})
            VALUES ${values}
            ON CONFLICT (filial, pedido, sku) DO NOTHING
            RETURNING id;
        `;
        const result = await sql(text, params);
        inserted += result.length;
    }
    return inserted;
}

export async function ensurePickingTable(sql) {
    await sql`
        CREATE TABLE IF NOT EXISTS picking_records (
            id SERIAL PRIMARY KEY,
            filial TEXT,
            data TEXT,
            data_fmt TEXT,
            pedido TEXT,
            sku TEXT,
            produto TEXT,
            qtd NUMERIC,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `;

    // Garante o índice único (filial, pedido, sku) para permitir ON CONFLICT DO NOTHING nas
    // sincronizações. Como a tabela já existia sem essa trava, registros duplicados de antes
    // são removidos primeiro (mantendo o mais antigo) — mas só na primeira vez, já que checar
    // isso em toda requisição faria um full scan desnecessário a cada carregamento do painel.
    const indexCheck = await sql`SELECT 1 FROM pg_indexes WHERE indexname = 'idx_picking_dedup'`;
    if (indexCheck.length === 0) {
        await sql`
            DELETE FROM picking_records a USING picking_records b
            WHERE a.id > b.id AND a.filial = b.filial AND a.pedido = b.pedido AND a.sku = b.sku;
        `;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_picking_dedup ON picking_records (filial, pedido, sku);`;
    }
}

export default async function handler(req, res) {
    if (!process.env.DATABASE_URL) {
        return res.status(500).json({ error: 'DATABASE_URL não configurada nas variáveis de ambiente da Vercel.' });
    }

    const sql = neon(process.env.DATABASE_URL);

    try {
        await ensurePickingTable(sql);
    } catch (e) {
        return res.status(500).json({ error: 'Erro ao preparar tabela: ' + e.message });
    }

    // BUSCAR DADOS
    if (req.method === 'GET') {
        try {
            // ?desde=AAAA-MM-DD limita a resposta a um período recente (o painel só carrega
            // o histórico completo quando alguém pede). Sem o parâmetro, devolve tudo.
            const desdeRaw = String(req.query.desde || '');
            const desde = /^\d{4}-\d{2}-\d{2}$/.test(desdeRaw) ? desdeRaw : null;
            const rows = await sql`
                SELECT filial, data, data_fmt, pedido, sku, produto, qtd
                FROM picking_records
                WHERE (${desde}::text IS NULL OR data >= ${desde})
                ORDER BY data DESC, id DESC;
            `;
            // Total real da base (o painel mostra no cabeçalho, mesmo com só parte carregada).
            const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM picking_records;`;
            res.setHeader('X-Total-Count', String(total));

            // A resposta é grande e igual pra todo mundo: a CDN da Vercel guarda por alguns
            // minutos, então várias aberturas de página não viram várias consultas ao Neon.
            // Quem acabou de sincronizar manda ?_=timestamp pra furar o cache e ver o dado novo.
            // (Só definido no sucesso, pra um erro do banco nunca ficar em cache.)
            if (req.query._) res.setHeader('Cache-Control', 'no-store');
            else res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
            return res.status(200).json(rows);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // INSERIR DADOS (em lote, com dedup por filial+pedido+sku)
    if (req.method === 'POST') {
        try {
            const records = req.body;
            if (!Array.isArray(records) || records.length === 0) {
                return res.status(400).json({ error: 'Nenhum dado recebido.' });
            }
            const inserted = await insertPickingRows(sql, records);
            return res.status(200).json({ success: true, count: records.length, inserted });
        } catch (error) {
            return res.status(500).json({ error: 'Falha ao gravar no Neon: ' + error.message });
        }
    }

    // LIMPAR TABELA
    if (req.method === 'DELETE') {
        try {
            await sql`TRUNCATE TABLE picking_records RESTART IDENTITY;`;
            return res.status(200).json({ success: true, message: 'Tabela limpa com sucesso!' });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    return res.status(405).json({ error: 'Método não permitido' });
}
