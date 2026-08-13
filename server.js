const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-rpg';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 初始化資料庫 (若不存在則建立 users 資料表)
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'warrior',
        hp_potion INT DEFAULT 5,
        mp_potion INT DEFAULT 5,
        exp_scroll INT DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("🟢 資料庫連線並初始化成功！");
  } catch (err) {
    console.error("🔴 資料庫初始化失敗：", err);
  }
}
initDB();

const wss = new WebSocket.Server({ port: PORT });
const rooms = {};
let matchQueue = [];

const ROLE_STATS = {
  mage:     { maxHp: 9000,  maxMp: 1200, critRate: 0.25, critMult: 1.8 },
  priest:   { maxHp: 10000, maxMp: 1000, critRate: 0.15, critMult: 1.5 },
  warrior:  { maxHp: 16000, maxMp: 500,  critRate: 0.15, critMult: 1.5 },
  knight:   { maxHp: 20000, maxMp: 400,  critRate: 0.10, critMult: 1.5 },
  assassin: { maxHp: 11000, maxMp: 600,  critRate: 0.35, critMult: 2.0 },
  archer:   { maxHp: 10500, maxMp: 650,  critRate: 0.30, critMult: 1.7 }
};

async function savePlayerInventory(dbId, inventory) {
  if (!dbId) return;
  try {
    await pool.query(
      `UPDATE users SET hp_potion = $1, mp_potion = $2, exp_scroll = $3 WHERE id = $4`,
      [inventory.hpPotion, inventory.mpPotion, inventory.expScroll, dbId]
    );
  } catch (err) {
    console.error("儲存玩家背包失敗:", err);
  }
}

function broadcastRoom(roomId, message) {
  if (rooms[roomId]) {
    rooms[roomId].players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(JSON.stringify(message));
    });
  }
}

function stopBattleTimer(room) {
  if (room && room.battleTimer) {
    clearInterval(room.battleTimer);
    room.battleTimer = null;
  }
}

function leaveRoom(player) {
  if (!player.roomId || !rooms[player.roomId]) return;
  const room = rooms[player.roomId];
  room.players = room.players.filter(p => p.id !== player.id);

  if (room.players.length === 0) {
    stopBattleTimer(room);
    delete rooms[player.roomId];
  } else {
    broadcastRoom(player.roomId, { type: 'room_state', status: room.status, players: getSanitizedPlayers(room.players) });
    broadcastRoom(player.roomId, { type: 'battle_log', message: `📢 玩家 ${player.name} 已離開房間。` });
  }
  player.roomId = null;
}

function getSanitizedPlayers(players) {
  return players.map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    team: p.team,
    hp: p.hp,
    maxHp: p.maxHp,
    mp: p.mp,
    maxMp: p.maxMp,
    inventory: p.inventory
  }));
}

wss.on('connection', (ws) => {
  let player = {
    id: Math.random().toString(36).substr(2, 9),
    dbId: null,
    ws: ws,
    name: '',
    role: 'warrior',
    team: 'A',
    roomId: null,
    hp: 16000,
    maxHp: 16000,
    mp: 500,
    maxMp: 500,
    critRate: 0.15,
    critMult: 1.5,
    inventory: { hpPotion: 5, mpPotion: 5, expScroll: 1 },
    idleTimer: null,
    stopIdlePractice: function() {
      if (this.idleTimer) {
        clearInterval(this.idleTimer);
        this.idleTimer = null;
      }
    }
  };

  function startIdlePractice() {
    player.stopIdlePractice();
    player.idleTimer = setInterval(() => {
      const isHp = Math.random() > 0.5;
      if (isHp) player.inventory.hpPotion += 1;
      else player.inventory.mpPotion += 1;

      savePlayerInventory(player.dbId, player.inventory);

      ws.send(JSON.stringify({
        type: 'idle_reward',
        inventory: player.inventory,
        message: `🧘‍♂️ 修練中... 獲得了 🧪 ${isHp ? 'HP' : 'MP'} 藥水 x1！(已保存至資料庫)`
      }));
    }, 10000);
  }

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // 📝 帳號註冊
      if (data.type === 'register') {
        const { username, password } = data;
        if (!username || !password) return ws.send(JSON.stringify({ type: 'error', message: '請輸入帳號與密碼！' }));

        const hash = await bcrypt.hash(password, 10);
        try {
          await pool.query(
            `INSERT INTO users (username, password_hash) VALUES ($1, $2)`,
            [username, hash]
          );
          ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功，請登入帳號！' }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', message: '帳號已被註冊，請換一個名稱！' }));
        }
      }

      // 🔑 帳號登入
      else if (data.type === 'login') {
        const { username, password } = data;
        const res = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        if (res.rows.length === 0) return ws.send(JSON.stringify({ type: 'error', message: '帳號不存在！' }));

        const dbUser = res.rows[0];
        const match = await bcrypt.compare(password, dbUser.password_hash);
        if (!match) return ws.send(JSON.stringify({ type: 'error', message: '密碼錯誤！' }));

        player.dbId = dbUser.id;
        player.name = dbUser.username;
        player.role = dbUser.role || 'warrior';
        player.inventory = {
          hpPotion: dbUser.hp_potion,
          mpPotion: dbUser.mp_potion,
          expScroll: dbUser.exp_scroll
        };

        const token = jwt.sign({ dbId: dbUser.id, username: dbUser.username }, JWT_SECRET, { expiresIn: '7d' });

        ws.send(JSON.stringify({
          type: 'login_success',
          token,
          user: { name: player.name, role: player.role, inventory: player.inventory }
        }));

        startIdlePractice();
      }

      // 🥊 快捷選單 & 遊戲邏輯與原本一致...
      else if (data.type === 'use_potion') {
        // 使用藥水並即時儲存至資料庫
        if (data.potionType === 'hp' && player.inventory.hpPotion > 0) {
          player.inventory.hpPotion--;
        } else if (data.potionType === 'mp' && player.inventory.mpPotion > 0) {
          player.inventory.mpPotion--;
        }
        await savePlayerInventory(player.dbId, player.inventory);
        ws.send(JSON.stringify({ type: 'inventory_update', inventory: player.inventory }));
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.on('close', () => {
    player.stopIdlePractice();
    leaveRoom(player);
  });
});

console.log(`🚀 WebSocket & 帳號驗證伺服器已啟動於 Port: ${PORT}`);
