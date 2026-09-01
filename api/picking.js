import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
    const sql = neon(process.env.DATABASE_URL);

    // Garante que a tabela exista
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

    // 1. BUSCAR DADOS
    if (req.method === 'GET') {
        try {
            const rows = await sql`SELECT filial, data, data_fmt, pedido, sku, produto, qtd FROM picking_records ORDER BY data DESC LIMIT 2000;`;
            return res.status(200).json(rows);
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // 2. INSERIR DADOS
    if (req.method === 'POST') {
        try {
            const records = req.body;
            if (!Array.isArray(records) || records.length === 0) {
                return res.status(400).json({ error: 'Nenhum dado enviado' });
            }

            for (const r of records) {
                await sql`
                    INSERT INTO picking_records (filial, data, data_fmt, pedido, sku, produto, qtd)
                    VALUES (${r.filial}, ${r.data}, ${r.data_fmt}, ${r.pedido}, ${r.sku}, ${r.produto}, ${r.qtd});
                `;
            }

            return res.status(200).json({ success: true, count: records.length });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // 3. LIMPAR / RESETAR BANCO DE DADOS (PROTEGIDO)
    if (req.method === 'DELETE') {
        try {
            await sql`TRUNCATE TABLE picking_records RESTART IDENTITY;`;
            return res.status(200).json({ success: true, message: 'Dados de separação apagados com sucesso!' });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    return res.status(405).json({ error: 'Método não permitido' });
}
