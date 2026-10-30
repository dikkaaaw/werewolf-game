# Werewolf Online — Operational Runbook

Petunjuk operasional darurat dan pemeliharaan sistem di Supabase dan Vercel.

---

## 1. Pemantauan Scheduler (pg_cron)

Untuk memastikan fase game terus berputar otomatis saat pemain diam:
```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'werewolf-advance-due-rooms')
order by start_time desc
limit 20;
```
- **Kondisi Normal:** Status `succeeded` muncul setiap ~5 detik.
- **Kondisi Anomali:** Jika ada status `failed`, periksa kolom `return_message`. Error biasanya terkait timeout transaksi atau lock contention.
- **Restart Job Darurat:**
  ```sql
  select cron.alter_job(
    job_id := (select jobid from cron.job where jobname = 'werewolf-advance-due-rooms'),
    active := true
  );
  ```

---

## 2. Pemantauan Realtime & Health Check

Pemeriksaan berkala endpoint sistem:
```bash
curl -H "x-health-secret: <HEALTH_SECRET>" https://your-domain.com/api/health
```
- Pastikan `"db": "connected"`.
- Pastikan `"realtime_channel_alive": true`.
- Pastikan `"cron_status": "succeeded"`.

---

## 3. Alerting & Incident Notification

Untuk memastikan downtime atau kegagalan scheduler segera terdeteksi:
1. **Synthetic Uptime Check (BetterStack / UptimeRobot):**
   - Target URL: `https://your-domain.com/api/health`
   - Interval: Setiap 60 detik.
   - Kriteria Insiden: HTTP status $\ne 200$ (misal 503 saat DB down).
   - Jalur Alert: Notifikasi otomatis ke Discord / Slack channel `#alerts` dan email tim on-call.
2. **Scheduler Failure Webhook (pg_cron Alerting):**
   Bila `cron.job_run_details` mencatat status `'failed'`, query watchdog internal mengirimkan alert via `pg_net` ke webhook Discord/Slack:
   ```sql
   select net.http_post(
     url := 'https://discord.com/api/webhooks/...',
     body := jsonb_build_object('content', '🚨 Werewolf pg_cron job failed!')
   );
   ```

---

## 4. Prosedur Rotasi Secret

### A. Rotasi `SCHEDULER_SECRET` & `HEALTH_SECRET`
1. Generate secret baru: `openssl rand -hex 32`.
2. Update di Vercel Dashboard $\rightarrow$ Environment Variables $\rightarrow$ Redeploy.
3. Update cron job jika memanggil via HTTP:
   Update token pada skrip cron eksternal / Vault.

### B. Rotasi `SUPABASE_SERVICE_ROLE_KEY`
1. Buka Supabase Dashboard $\rightarrow$ Project Settings $\rightarrow$ API $\rightarrow$ Generate New Secret Key.
2. Update nilai `SUPABASE_SERVICE_ROLE_KEY` di Vercel Environment Variables.
3. Lakukan redeploy produksi agar instance serverless mengadopsi key baru seketika.
4. Revoke key lama di Supabase Dashboard setelah deployment baru berstatus `READY`.

---

## 4. Prosedur Rollback Migrasi Database
Jika migrasi terbaru menimbulkan anomali di database:
1. Temukan file migrasi terkait di `supabase/migrations/`.
2. Tulis migrasi pembalik (`00XX_revert_...sql`) yang mendrop fungsi/policy yang bermasalah dan mengembalikan versi sebelumnya.
3. Jalankan `supabase db push` atau apply via SQL Editor. Jangan pernah mengedit riwayat tabel `supabase_migrations.schema_migrations` secara manual.
