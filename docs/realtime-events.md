# Realtime Events Contract

Dokumentasi spesifikasi protokol WebSocket Supabase Realtime (Broadcast & Presence) untuk Werewolf Game.

---

## 1. Channel
- **Nama Channel:** `room:{roomId}`
- **Tipe:** Ephemeral WebSocket Room Channel
- **Konfigurasi Presence:**
  ```ts
  {
    config: {
      presence: {
        key: user.id, // UUID pemain aktif
      },
    },
  }
  ```

---

## 2. Broadcast Events

### A. Event: `room_updated`
- **Tujuan:** Memberitahu semua klien di kamar bahwa state database (status, phase, round, roster, vote tally, settings) telah berubah.
- **Siapa yang Boleh Publish:**
  - Klien browser pemain aktif setelah berhasil menerima respons HTTP 200 dari mutasi server (`/api/rooms/*`).
  - Klien yang mendeteksi wake-up dari tab background (`visibility_wake`).
- **Siapa yang Subscribe:** Semua browser klien di room tersebut.
- **Payload Shape:**
  ```ts
  {
    reason: 'ready' | 'start_game' | 'night_action' | 'vote' | 'hunter_shot' | 'dev_bots' | 'settings' | 'presence_joined' | 'visibility_wake',
    timestamp: number // unix epoch ms saat event dikirim
  }
  ```
- **Tindakan Klien Saat Menerima:**
  Klien memicu `requestRefresh({ force: true })` dengan request coalescing (menyatukan broadcast burst dalam jendela 50ms menjadi 1 request HTTP snapshot).

### B. Event: `chat_message`
- **Tujuan:** Mengirimkan pesan obrolan desa secara instan (<50ms) antar pemain tanpa menunggu interval polling 4 detik.
- **Siapa yang Boleh Publish:** Klien pemain hidup setelah pesan berhasil disimpan via `POST /api/rooms/:id/chat`.
- **Siapa yang Subscribe:** Semua pemain di room yang membuka panel chat.
- **Payload Shape:**
  ```ts
  {
    id: string,              // UUID pesan
    round_number: number,    // Ronde saat pesan dikirim
    author_player_id: string,// ID pemain penulis
    author_name: string,     // Display name penulis
    message: string,         // Teks pesan chat
    created_at: string       // ISO timestamp
  }
  ```
- **Tindakan Klien Saat Menerima:**
  Pesan langsung di-append ke daftar pesan lokal tanpa perlu me-reload snapshot kamar.

---

## 3. Presence Tracking (Online / Offline Roster)

- **Event:** `presence.sync`
- **Track Payload:**
  ```ts
  {
    userId: string,
    onlineAt: string // ISO timestamp
  }
  ```
- **Mekanisme Reconnect & Offline:**
  - Saat tab ditutup / browser disconnect: Supabase otomatis memancarkan status leave dalam beberapa detik, dan klien lain memperbarui indikator pemain menjadi offline (dot abu-abu).
  - Saat koneksi pulih / tab dibuka kembali: Presence secara otomatis di-retrack dan state kamar disinkronkan seketika melalui listener `visibilitychange` dan `online`.

---

## 4. Observability & Logging Standards

Setiap tindakan broadcast dan transisi fase dicatat dengan format JSON satu baris:
- Transisi fase: `[phase] {"roomId":"...","toPhase":"night","roundNumber":1,"durationMs":12,"advanced":true}`
- Broadcast publish: `[broadcast] {"roomId":"...","event":"room_updated","reason":"vote","latencyMs":24,"status":"ok"}`
- RLS blocker: `[rls] {"table":"rooms","operation":"SELECT","roomId":"...","reason":"..."}`
