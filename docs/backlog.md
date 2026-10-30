# Backlog Fitur & Polish (P1 / P2)

Daftar item non-blocker yang dikumpulkan dari audit dan sesi playtest untuk dikerjakan pada iterasi pasca-hardening.

---

## Prioritas P1 (Hardening, Reliabilitas & Operasional)

| ID | Item | Estimasi | Deskripsi & Catatan Teknis |
|---|---|---|---|
| **P1-1** | **Host Migration UI Feedback** | 2 jam | Saat host keluar di lobby atau setelah game selesai, tampilkan banner toast ke semua pemain yang mengumumkan siapa yang menjadi host baru. |
| **P1-2** | **Night Banner Guidance for Inactive Roles** | 1 jam | Menampilkan pesan panduan yang jelas di banner malam bagi pemain Villager: *"Desa tertidur lelap. Menunggu malam berakhir..."* agar pemain tidak mengira aplikasi hang saat tidak memiliki tombol aksi malam. |
| **P1-3** | **Kick Inactive Lobby Player** | 3 jam | Memberikan tombol bagi Host di lobby untuk mengeluarkan (kick) pemain yang AFK / tidak kunjung Ready sebelum game dimulai. |
| **P1-4** | **Error Tracking (Sentry Integration)** | 4 jam | Integrasikan `@sentry/nextjs` pada API routes dan client-side untuk menangkap unhandled error dan crash runtime secara real-time. |
| **P1-5** | **Production Rate Limit Tuning** | 3 jam | Tetapkan angka kuota konkret di `SETTINGS.rateLimits`: `createRoom`: 5/jam, `joinRoom`: 20/menit, `submitAction`: 15/menit, `submitVote`: 20/menit, `sendChat`: 30/menit. |
| **P1-6** | **Session Cleanup Worker** | 3 jam | Job cron harian untuk membersihkan akun/kredensial yang `locked_until` sudah lewat dan tidak pernah aktif kembali > 30 hari. |
| **P1-7** | **Room Retention Cleanup** | 4 jam | Menjalankan RPC `run_cleanup` secara berkala via pg_cron untuk menghapus kamar berstatus `finished` yang berusia > 24 jam dan kamar lobby idle > 2 jam. |

---

## Prioritas P2 (Nice-to-Have & Visual Polish)

| ID | Item | Estimasi | Deskripsi & Catatan Teknis |
|---|---|---|---|
| **P2-1** | **Spectator Mode** | 16–24 jam | Mengizinkan user baru yang bergabung saat game `in_progress` untuk masuk sebagai penonton (spectator) yang hanya bisa membaca obrolan publik dan log desa tanpa hak memilih atau bersuara. |
| **P2-2** | **Dedicated Werewolf Pack Night Chat** | 10–14 jam | Membuat tab obrolan terpisah khusus untuk pemain Werewolf saat malam hari via private channel broadcast terisolasi. |
| **P2-3** | **Unread Chat Badge** | 2 jam | Menampilkan badge jumlah pesan baru pada panel chat jika posisi scroll pemain sedang berada di atas (tidak di paling bawah). |
| **P2-4** | **Audio Atmosphere & SFX** | 4 jam | Menambahkan efek suara opsional (lolongan serigala saat malam, kokok ayam saat fajar, lonceng gereja saat voting lynch). |
| **P2-5** | **Hunter Shot Cinematic Reveal** | 3 jam | Animasi visual khusus di timeline saat Hunter menembak sebelum gugur. |
| **P2-6** | **State-Push Payload Migration** | 12–16 jam | Jika kapasitas kamar dinaikkan menjadi > 15–20 pemain aktif, migrasikan broadcast dari sinyal re-fetch menjadi payload snapshot penuh (lihat `docs/decisions/0002-realtime-and-observability.md`). |
