import pg from 'pg';
const { Pool } = pg;

const url = process.env.DATABASE_URL;
export const pool = new Pool({
  connectionString: url,
  ssl: url && !url.includes('localhost') ? { rejectUnauthorized: false } : false
});

export async function withClient(fn){
  const c = await pool.connect();
  try{ return await fn(c); } finally{ c.release(); }
}

export async function migrate(){
  await withClient(async (c)=>{
    await c.query(`
      create table if not exists admin_clears(
        order_id text primary key,
        cleared boolean not null default true,
        cleared_at timestamptz not null default now()
      );
      create table if not exists admin_tables(
        table_no text primary key,
        active boolean not null default true
      );
      create table if not exists admin_qr_history(
        id serial primary key,
        url text not null,
        created_at timestamptz not null default now()
      );
    `);
  });
}
