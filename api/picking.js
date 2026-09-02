import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    if (!process.env.DATABASE_URL) {
        return res.status(500).json({ error: 'DATABASE_URL não configurada nas variáveis de ambiente da Vercel.' });
    }

    const sql = neon(process.env.DATABASE_URL);

    // Cria a tabela caso não exista
    try {
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
    } catch (e) {
        return res.status(500).json({ error: 'Erro ao conectar/criar tabela: ' + e.message });
    }

    // BUSCAR DADOS
    if (req.method === 'GET') {
        try {
            const rows = await sql`SELECT filial, data, data_fmt, pedido, sku, produto, qtd FROM picking_records ORDER BY id DESC LIMIT 5000;`;
            return res.status(200).json(rows);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // INSERIR DADOS (Em lote super rápido)
    if (req.method === 'POST') {
        try {
            const records = req.body;
            if (!Array.isArray(records) || records.length === 0) {
                return res.status(400).json({ error: 'Nenhum dado recebido.' });
            }

            // Inserção em lote (batch) para não estourar o tempo da Vercel
            const batchSize = 100;
            for (let i = 0; i < records.length; i += batchSize) {
                const chunk = records.slice(i, i + batchSize);
                await Promise.all(chunk.map(r => 
                    sql`
                        INSERT INTO picking_records (filial, data, data_fmt, pedido, sku, produto, qtd)
                        VALUES (${r.filial || '-'}, ${r.data || ''}, ${r.data_fmt || '-'}, ${r.pedido || '-'}, ${r.sku || '-'}, ${r.produto || '-'}, ${Number(r.qtd) || 1});
                    `
                ));
            }

            return res.status(200).json({ success: true, count: records.length });
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
