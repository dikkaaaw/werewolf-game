# Production Deployment Guide & Checklist

Panduan deployment produksi resmi untuk Werewolf Online di Vercel dan Supabase.

---

## 1. Environment Variables Wajib (Production)

| Variable | Lingkungan | Sifat | Deskripsi |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Build + Runtime | Publik | URL API Supabase (`https://<project-ref>.supabase.co`). |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Build + Runtime | Publik | Kunci publishable Supabase (`sb_publishable_...`). Dilindungi RLS. |
| `SUPABASE_SERVICE_ROLE_KEY` | Runtime Only | Rahasia | Kunci service role backend (`sb_secret_...` / JWT). Melewati RLS. |
| `SCHEDULER_SECRET` | Runtime Only | Rahasia | Token acak minimal 32 karakter untuk otorisasi endpoint cron. |
| `HEALTH_SECRET` | Runtime Only | Rahasia | Token otorisasi untuk membaca metrik lengkap di `GET /api/health`. |

---

## 2. Checklist Pra-Deploy (Wajib Lulus Sebelum Live)

Sebelum mempublikasikan build ke Production di Vercel:
- [ ] `DISABLE_RATE_LIMIT`: **TIDAK DI-SET** (atau bernilai `false`). Rate limiter harus aktif menjaga database.
- [ ] `ALLOW_TEST_BOTS`: **TIDAK DI-SET** (atau bernilai `false`). Endpoint `/api/rooms/:id/dev-add-bots` harus mengembalikan 404.
- [ ] `NEXT_PUBLIC_ALLOW_TEST_BOTS`: **TIDAK DI-SET** (atau bernilai `false`). Tombol bot tidak boleh tampil di UI.
- [ ] `HEALTH_SECRET`: **DI-SET** dengan token acak kuat (`openssl rand -hex 32`).
- [ ] `SCHEDULER_SECRET`: **DI-SET** dengan token acak kuat (`openssl rand -hex 32`).
- [ ] `supabase db diff --linked`: **KOSONG** (seluruh 38 migrasi telah diterapkan ke database live).
- [ ] Supabase `pg_cron` aktif dan mengeksekusi job `werewolf-advance-due-rooms` tanpa status failed.

---

## 3. Langkah-Langkah Deploy

1. **Database Supabase:**
   ```bash
   supabase link --project-ref <project-ref>
   supabase db push
   ```
2. **Konfigurasi Vercel:**
   Pastikan kelima environment variable di atas telah dikonfigurasi di Vercel Dashboard $\rightarrow$ Settings $\rightarrow$ Environment Variables (Target: `Production`).
3. **Trigger Deployment:**
   ```bash
   git push origin main
   ```
4. **Verifikasi Post-Deploy:**
   - Jalankan `curl -i https://your-domain.com/api/health` $\rightarrow$ harus mengembalikan `{ ok: true, status: 'healthy' }` tanpa membocorkan `migrations_count` atau `cron_last_run`.
   - Jalankan `curl -i -H "x-health-secret: <HEALTH_SECRET>" https://your-domain.com/api/health` $\rightarrow$ harus mengembalikan metrik lengkap dengan status `cron_status: 'succeeded'`.

---

## 4. Backup & Disaster Recovery (RPO & RTO)

- **Point-in-Time Recovery (PITR):** Supabase Pro menyediakan PITR aktif hingga 7 hari ke belakang. Pada tier Hobby/Free, backup fisik harian otomatis dibuat oleh platform.
- **RPO (Recovery Point Objective):**
  - Production (dengan PITR): $\le 2\text{ menit}$.
  - Free / Staging: $\le 24\text{ jam}$ (snapshot harian).
- **RTO (Recovery Time Objective):** $\le 15\text{ menit}$ untuk restore point via Supabase Dashboard.
- **Akses Backup:** Dibatasi hanya untuk pemilik organisasi database (role `Owner` di Supabase Project).
- **Prosedur Uji Restore:** Lakukan restore berkala ke project staging cabang terpisah setiap kuartal untuk memvalidasi integritas data tabel `player_credentials` dan skema migrasi.
