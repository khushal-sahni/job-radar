const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://jobradar:jobradar@localhost:5433/job_radar?schema=public' });

const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

pool.query(`SELECT source, count(*) as cnt FROM "Job" WHERE "fetchedAt" < $1 AND "isActive" = true GROUP BY source ORDER BY cnt DESC`, [cutoff])
  .then(r => {
    console.log('Jobs older than 30 days that are still active:');
    console.table(r.rows);
    const total = r.rows.reduce((s, row) => s + Number(row.cnt), 0);
    console.log('Total to mark inactive:', total);

    return pool.query(`UPDATE "Job" SET "isActive" = false WHERE "fetchedAt" < $1 AND "isActive" = true`, [cutoff]);
  })
  .then(r => {
    console.log('Marked ' + r.rowCount + ' old jobs as inactive');
    return pool.query(`SELECT count(*) as cnt FROM "Job" WHERE "isActive" = true`);
  })
  .then(r => {
    console.log('Remaining active jobs:', r.rows[0].cnt);
    pool.end();
  })
  .catch(err => { console.error(err); pool.end(); });