# Decision: Realtime Architecture, Logging, and Scalability Limits

## Context & Problem
Pada MVP awal, aplikasi mengandalkan `postgres_changes` yang membebani WAL database replication. Telah diputuskan beralih ke **Supabase Realtime Private Channels** dengan Broadcast dan Presence.

## Decision & Trade-offs
1. **Private Channels via Realtime Authorization:**
   Channel `room:{roomId}` dikunci menggunakan `config: { private: true }`. Otorisasi ditangani melalui RLS `realtime.messages` dengan fungsi `public.is_channel_member(realtime.topic())`.
2. **Broadcast-Driven Re-fetch Model:**
   Setiap ada mutasi, klien memancarkan event `room_updated` dengan `stateVersion`. Klien lain yang menerima event membandingkan `stateVersion`: jika sudah sama, re-fetch dilewati; jika berbeda, klien me-refresh snapshot room secara coalesced (jendela 50ms).
   - **Batas Skalabilitas:** Model ini sangat optimal, ringan, dan sederhana untuk kapasitas private room 5–12 pemain.
   - **Threshold Migrasi State-Push:** Jika skala permainan dinaikkan menjadi > 15–20 pemain aktif per room yang sangat sibuk, re-fetch berulang dapat memicu beban concurrent HTTP ke endpoint snapshot. Pada titik tersebut, payload `room_updated` harus beralih dari sinyal refresh menjadi *full state-push payload*.
3. **Observability & Log RLS Heuristik:**
   Prefix logging terstruktur:
   - `[phase]`: Mencatat durasi dan transisi fase oleh `tick_room`.
   - `[broadcast]`: Mencatat status dan latency pengiriman WebSocket.
   - `[rls]`: Heuristik server-side yang mencatat penolakan akses membership. Perlu dicatat bahwa penolakan ini dapat memicu *false-positive* bila klien salah memasukkan UUID room yang memang tidak ada (404). Untuk audit RLS database absolut di production, gunakan Supabase Postgres log `log_statement = 'all'`.
