# Realtime Contract: Supabase Broadcast & Presence

Sistem Realtime permainan Werewolf menggunakan WebSocket channel ephemeral Supabase Realtime (`room:{roomId}`), menggantikan seluruh ketergantungan pada `postgres_changes`.

---

## 1. Channel
- **Channel Name:** `room:{roomId}`
- **Config:**
  ```ts
  {
    config: {
      presence: { key: user.id }
    }
  }
  ```

---

## 2. Broadcast Events

### Event: `room_updated`
Event ini di-broadcast setiap kali terjadi perubahan state room oleh pemain. Semua browser di room yang sama mendengarkan event ini dan langsung melakukan snapshot refresh instan (<50ms).

- **Payload:**
  ```ts
  {
    reason: 'ready' | 'start_game' | 'night_action' | 'vote' | 'hunter_shot' | 'dev_bots' | 'settings' | 'presence_joined',
    timestamp: number
  }
  ```
- **Kapan Dikirim:**
  - `ready`: pemain klik Ready / Unready.
  - `start_game`: host menekan Start Game.
  - `night_action`: Werewolf strike / Seer inspect / Guardian Angel protect.
  - `vote`: pemain memilih target lynch di voting phase.
  - `hunter_shot`: Hunter mengeksekusi tembakan terakhir.
  - `dev_bots`: host menambahkan bot uji di lobby dev.
  - `settings`: host menyimpan perubahan durasi atau komposisi peran.
  - `presence_joined`: klien baru selesai melakukan subscribe dan terhubung ke room.

---

## 3. Presence Tracking (Online / Offline)

- **Track Payload:**
  ```ts
  {
    userId: string,
    onlineAt: string // ISO timestamp
  }
  ```
- **Event: `sync`**
  - Merekam daftar `userId` aktif dari `channel.presenceState()`.
  - Komponen `LobbyPanel` dan `PlayerRoster` menampilkan status dot hijau (online) vs abu-abu (offline) secara otomatis saat pemain masuk atau menutup browser/tab.

---

## 4. Polling & Concurrency Guard
- **Tidak ada polling 1s/2s.**
- **Heartbeat fallback:** 15 detik selama permainan berjalan (`in_progress`) sebagai safety net bila koneksi WebSocket internet pemain sempat terputus.
- **Coalescing scheduler:** jika dalam jendela waktu 50ms ada multiple broadcast (misal 3 pemain vote bersamaan), request HTTP refresh ke server digabungkan menjadi 1 network request saja.
