import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { migrate, withClient, pool } from './db.js';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 4001;

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const ORDER_BASE = process.env.ORDER_BASE || API_BASE; // QR uses this base

await migrate();
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

app.get('/admin-config', (_req,res)=> res.json({ apiBase: API_BASE, orderBase: ORDER_BASE }));

app.get('/login', (_req,res)=> res.sendFile(path.join(__dirname,'public','login.html')));
app.get('/', (_req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, ()=> console.log('Admin v15.8 on :'+PORT));

// --- Admin DB APIs ---
app.get('/adb/clears', async (_req,res)=>{
  try{
    const rows = await withClient(c=> c.query('select order_id from admin_clears where cleared=true'));
    res.json({ cleared: rows.rows.map(r=> r.order_id) });
  }catch(e){ res.status(500).json({ cleared: [] }); }
});
app.post('/adb/clear', express.json(), async (req,res)=>{
  try{
    const { orderId } = req.body||{};
    if(!orderId) return res.status(400).send('orderId required');
    await withClient(c=> c.query(`insert into admin_clears(order_id,cleared) values($1,true)
      on conflict (order_id) do update set cleared=true, cleared_at=now()`, [orderId]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
app.post('/adb/unclear', express.json(), async (req,res)=>{
  try{
    const { orderId } = req.body||{};
    if(!orderId) return res.status(400).send('orderId required');
    await withClient(c=> c.query('delete from admin_clears where order_id=$1', [orderId]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
app.get('/adb/tables', async (_req,res)=>{
  try{
    const rows = await withClient(c=> c.query('select table_no, active from admin_tables order by table_no::int nulls last, table_no'));
    res.json(rows.rows);
  }catch(e){ res.status(500).json([]); }
});
app.post('/adb/tables/add', express.json(), async (req,res)=>{
  try{
    const { tableNo } = req.body||{};
    if(!tableNo) return res.status(400).send('tableNo required');
    await withClient(c=> c.query('insert into admin_tables(table_no,active) values($1,true) on conflict do nothing', [String(tableNo)]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
app.post('/adb/tables/toggle', express.json(), async (req,res)=>{
  try{
    const { tableNo, active } = req.body||{};
    await withClient(c=> c.query('update admin_tables set active=$2 where table_no=$1', [String(tableNo), !!active]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
app.get('/adb/qr-history', async (_req,res)=>{
  try{
    const rows = await withClient(c=> c.query('select id, url, created_at from admin_qr_history order by id desc limit 50'));
    res.json(rows.rows);
  }catch(e){ res.status(500).json([]); }
});
app.post('/adb/qr-history', express.json(), async (req,res)=>{
  try{
    const { url } = req.body||{};
    if(!url) return res.status(400).send('url required');
    await withClient(c=> c.query('insert into admin_qr_history(url) values($1)', [url]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
process.on('SIGTERM', ()=>{ pool.end().then(()=> process.exit(0)); });

// ===== Admin Data Layer =====

// util: parse tableNo from QR url
function parseTableFromUrl(u){ try{ const z=new URL(u); return z.searchParams.get('table')||null; }catch(_){ return null; } }

// ---- Orders mirror ----
app.post('/adb/sync/orders', async (_req,res)=>{
  try{
    const r = await fetch(API_BASE+'/orders?includeCleared=1');
    if(!r.ok) return res.status(502).send('api fail');
    const arr = await r.json();
    for(const o of arr){
      const items = Array.isArray(o.items)? o.items : [];
      await withClient(c=> c.query(`
        insert into admin_orders(id, table_no, amount, status, created_at, cleared, payment_key, items)
        values($1,$2,$3,$4,coalesce($5, now()), coalesce($6,false), coalesce($7,''), $8)
        on conflict (id) do update set table_no=excluded.table_no, amount=excluded.amount, status=excluded.status, created_at=excluded.created_at, cleared=excluded.cleared, payment_key=excluded.payment_key, items=excluded.items
      `, [o.id, String(o.tableNo||''), Number(o.amount||0), String(o.status||'접수'), o.createdAt? new Date(o.createdAt): null, !!o.cleared, o.paymentKey||'', JSON.stringify(items)]));
    }
    res.json({ ok:true, count: arr.length });
  }catch(e){ console.error(e); res.status(500).json({ ok:false }); }
});

app.get('/adb/orders', async (req,res)=>{
  try{
    const include = String(req.query.includeCleared||'0')==='1';
    const table = (req.query.table||'').trim();
    let q='select * from admin_orders', cond=[], vals=[];
    if(table){ cond.push('table_no=$'+(vals.length+1)); vals.push(table); }
    if(!include){ cond.push('cleared=false'); }
    if(cond.length) q+=' where '+cond.join(' and ');
    q+=' order by created_at desc';
    const rows = await withClient(c=> c.query(q, vals));
    res.json(rows.rows);
  }catch(e){ res.status(500).json([]); }
});

app.post('/adb/order-status', express.json(), async (req,res)=>{
  try{
    const { id, status } = req.body||{};
    if(!id) return res.status(400).send('id required');
    // forward to API
    await fetch(API_BASE+'/orders/'+encodeURIComponent(id), { method:'PATCH', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') }, body: JSON.stringify({ status }) });
    // persist
    await withClient(c=> c.query('update admin_orders set status=$2 where id=$1', [id, String(status||'')]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

app.post('/adb/order-clear', express.json(), async (req,res)=>{
  try{
    const { id, cleared=true } = req.body||{};
    if(!id) return res.status(400).send('id required');
    await withClient(c=> c.query('update admin_orders set cleared=$2 where id=$1', [id, !!cleared]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// ---- Refund proxy (persists) ----
app.post('/adb/refund', express.json(), async (req,res)=>{
  try{
    const { id } = req.body||{};
    if(!id) return res.status(400).send('id required');
    const r = await fetch(API_BASE+'/refund/'+encodeURIComponent(id), { method:'POST', headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    if(!r.ok){ const t=await r.text(); return res.status(502).send(t||'refund fail'); }
    await withClient(c=> c.query('update admin_orders set status=$2 where id=$1', [id, '환불']));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// ---- Menu mirror ----
app.get('/adb/menu', async (_req,res)=>{
  try{
    const r = await fetch(API_BASE+'/menu');
    if(!r.ok) return res.status(502).send('api fail');
    const arr = await r.json();
    for(const m of arr){
      await withClient(c=> c.query(`
        insert into admin_menus(id,name,price,active,soldout,updated_at)
        values($1,$2,$3,$4,$5,now())
        on conflict (id) do update set name=excluded.name, price=excluded.price, active=excluded.active, soldout=excluded.soldout, updated_at=now()
      `, [m.id, m.name, Number(m.price||0), !!m.active, !!m.soldout]));
    }
    const out = await withClient(c=> c.query('select * from admin_menus order by name'));
    res.json(out.rows);
  }catch(e){ res.status(500).json([]); }
});

app.post('/adb/menu', express.json(), async (req,res)=>{
  try{
    const m = req.body||{};
    // forward
    await fetch(API_BASE+'/menu', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') }, body: JSON.stringify(m) });
    // persist
    await withClient(c=> c.query(`insert into admin_menus(id,name,price,active,soldout,updated_at) values($1,$2,$3,$4,$5,now())
      on conflict (id) do update set name=$2, price=$3, active=$4, soldout=$5, updated_at=now()`,
      [m.id, m.name, Number(m.price||0), !!m.active, !!m.soldout]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

app.patch('/adb/menu/:id', express.json(), async (req,res)=>{
  try{
    const id = req.params.id;
    const m = req.body||{};
    await fetch(API_BASE+'/menu/'+encodeURIComponent(id), { method:'PATCH', headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') }, body: JSON.stringify(m) });
    await withClient(c=> c.query(`update admin_menus set name=coalesce($2,name), price=coalesce($3,price), active=coalesce($4,active), soldout=coalesce($5,soldout), updated_at=now() where id=$1`,
      [id, m.name, m.price!=null?Number(m.price):None, m.active, m.soldout]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});

// ---- Daily code mirror ----
app.get('/adb/daily-code', async (_req,res)=>{
  try{
    const r = await fetch(API_BASE+'/daily-code', { headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    if(!r.ok) return res.status(502).send('api fail');
    const j = await r.json();
    await withClient(c=> c.query(`insert into admin_daily_codes(code_date,code,override,saved_at) values($1,$2,$3,now())
      on conflict (code_date) do update set code=$2, override=$3, saved_at=now()`, [j.date, j.code, !!j.override]));
    res.json(j);
  }catch(e){ res.status(500).json({}); }
});
app.post('/adb/daily-code/regen', async (_req,res)=>{
  try{
    const r = await fetch(API_BASE+'/daily-code/regen', { method:'POST', headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    if(!r.ok) return res.status(502).send('api fail');
    const j = await r.json();
    // re-read and store
    const r2 = await fetch(API_BASE+'/daily-code', { headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    const j2 = await r2.json();
    await withClient(c=> c.query(`insert into admin_daily_codes(code_date,code,override,saved_at) values($1,$2,$3,now())
      on conflict (code_date) do update set code=$2, override=$3, saved_at=now()`, [j2.date, j2.code, !!j2.override]));
    res.json(j);
  }catch(e){ res.status(500).json({}); }
});
app.post('/adb/daily-code/clear', async (_req,res)=>{
  try{
    const r = await fetch(API_BASE+'/daily-code/clear', { method:'POST', headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    if(!r.ok) return res.status(502).send('api fail');
    const j = await r.json();
    const r2 = await fetch(API_BASE+'/daily-code', { headers:{ 'Authorization':'Bearer '+(process.env.ADMIN_PASSWORD||'') } });
    const j2 = await r2.json();
    await withClient(c=> c.query(`insert into admin_daily_codes(code_date,code,override,saved_at) values($1,$2,$3,now())
      on conflict (code_date) do update set code=$2, override=$3, saved_at=now()`, [j2.date, j2.code, !!j2.override]));
    res.json(j);
  }catch(e){ res.status(500).json({}); }
});

// ---- QR history store with table_no
app.post('/adb/qr-history', express.json(), async (req,res)=>{
  try{
    const { url } = req.body||{};
    if(!url) return res.status(400).send('url required');
    const t = parseTableFromUrl(url);
    await withClient(c=> c.query('insert into admin_qr_history(url, table_no) values($1,$2)', [url, t]));
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ ok:false }); }
});
