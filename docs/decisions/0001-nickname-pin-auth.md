# Decision: Secure Nickname + Passphrase Authentication with Bcrypt KDF

## Context & Problem
Pada implementasi awal, identitas anonim bergantung pada `signInAnonymously()`. Jika storage browser terhapus atau pemain berganti perangkat/incognito, sesi terputus permanen dan pemain terkunci dari permainannya.
Desain transisi sempat memakai kombinasi hash deterministik SHA-256(nickname + pin), yang memiliki risiko:
1. `user_id` dapat direkonstruksi oleh pihak luar jika salt diketahui atau melalui offline dictionary attack.
2. SHA-256 adalah algoritma cepat tanpa perlindungan terhadap brute-force modern.

## Decision
1. **Identitas Pengguna:**
   `user_id` adalah UUID acak murni (`gen_random_uuid()`) yang dibuat oleh server saat registrasi pertama. Tidak dapat ditebak atau diturunkan dari nickname/PIN oleh pihak luar.
2. **Kredensial & KDF:**
   PIN/Passphrase dinaikkan menjadi **minimal 8 karakter alfanumerik** (atau passphrase multi-kata). Disimpan di tabel privat `public.player_credentials` menggunakan **Bcrypt cost 10** (`pgcrypto`).
3. **Proteksi Brute-force & Rate Limit:**
   - Rate limit IP request mandiri (tidak terpengaruh oleh `DISABLE_RATE_LIMIT`).
   - Exponential backoff per akun di level database (`failed_attempts` → `locked_until = now() + (2^n) seconds`), maks 30 menit.
4. **Session Issuance:**
   Menggunakan Supabase Auth standar (`signInWithPassword`) dengan kata sandi acak internal sementara (ephemeral), yang otomatis menulis cookie sesi browser `@supabase/ssr`.
5. **Privasi & Keamanan:**
   Tabel `player_credentials` memiliki RLS terkunci penuh (0 policy untuk `anon`/`authenticated`, hanya dapat diakses melalui RPC `SECURITY DEFINER` oleh `service_role`). Tidak ada log di server maupun client yang mencetak PIN atau UUID mentah.
