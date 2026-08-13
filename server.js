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

// 1. 初始化資料庫
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

// 2. 全域變數管理
const wss = new WebSocket.Server({ port: PORT });
const rooms = {}; // 儲存所有房間資料
let matchQueue = []; // 1v1 配對佇列

// 職業基礎屬性定義
const ROLE_STATS = {
  warrior: { hp: 16000, mp: 2000 },
  mage:    { hp: 9000,  mp: 5000 },
  priest:  { hp: 10000, mp: 4500 },
  knight:  { hp: 20000, mp: 1800 },
  assassin:{ hp: 11000, mp: 3000 },
  archer:  { hp: 10500, mp: 3200 }
};

// 廣播給房間內所有玩家
function broadcastRoomState(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const statePayload = JSON.stringify({
    type: 'room_state',
    roomId: roomId,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      team: p.team,
      hp: p.hp,
      maxHp: p.maxHp,
      mp: p.mp,
      maxMp: p.maxMp,
      inventory: p.inventory
    }))
  });

  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(statePayload);
    }
  });
}

// 廣播戰鬥日誌
function broadcastBattleLog(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const payload = JSON.stringify({ type: 'battle_log', message });
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  });
}

// 自動掛機獎勵計時器 (每 10 秒發送)
setInterval(async () => {
  for (let client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.user && client.isIdle) {
      const isHp = Math.random() > 0.5;
      const col = isHp ? 'hp_potion' : 'mp_potion';
      const itemText = isHp ? 'HP 藥水 x1' : 'MP 藥水 x1';

      try {
        const res = await pool.query(
          `UPDATE users SET ${col} = ${col} + 1 WHERE id = $1 RETURNING hp_potion, mp_potion, exp_scroll`,
          [client.user.id]
        );
        const inv = res.rows[0];
        client.user.inventory = {
          hpPotion: inv.hp_potion,
          mpPotion: inv.mp_potion,
          expScroll: inv.exp_scroll
        };
        client.send(JSON.stringify({
          type: 'idle_reward',
          message: `🧘 修練中... 獲得了 🧪 ${itemText}！(已保存至資料庫)`,
          inventory: client.user.inventory
        }));
      } catch (err) {
        console.error("掛機獎勵更新失敗:", err);
      }
    }
  }
}, 10000);

// 3. WebSocket 核心邏輯
wss.on('connection', (ws) => {
  ws.id = 'PLAYER_' + Math.random().toString(36).substr(2, 9);
  ws.isIdle = false;

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // --- 註冊 ---
      if (data.type === 'register') {
        const { username, password } = data;
        const hash = await bcrypt.hash(password, 10);
        try {
          await pool.query(
            'INSERT INTO users (username, password_hash) VALUES ($1, $2)',
            [username, hash]
          );
          ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功！請直接登入。' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號名稱已被使用！' }));
        }
      }

      // --- 登入 ---
      else if (data.type === 'login') {
        const { username, password } = data;
        const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (res.rows.length === 0) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));
        }
        const user = res.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));
        }

        ws.user = {
          id: user.id,
          name: user.username,
          role: user.role,
          inventory: {
            hpPotion: user.hp_potion,
            mpPotion: user.mp_potion,
            expScroll: user.exp_scroll
          }
        };
        ws.isIdle = true;

        ws.send(JSON.stringify({
          type: 'login_success',
          user: ws.user
        }));
      }

      // --- 1v1 隨機匹配 ---
      else if (data.type === 'join_queue') {
        // 從舊佇列中清理掉無效連線或重複請求
        matchQueue = matchQueue.filter(p => p.ws.readyState === WebSocket.OPEN && p.ws !== ws);

        const role = data.role || (ws.user ? ws.user.role : 'warrior');
        const name = data.name || (ws.user ? ws.user.name : '勇者');

        matchQueue.push({ ws, id: ws.id, name, role, user: ws.user });
        ws.isIdle = false;
        ws.send(JSON.stringify({ type: 'queue_joined' }));

        // 滿 2 人自動配對
        if (matchQueue.length >= 2) {
          const p1 = matchQueue.shift();
          const p2 = matchQueue.shift();

          const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
          const stats1 = ROLE_STATS[p1.role] || ROLE_STATS.warrior;
          const stats2 = ROLE_STATS[p2.role] || ROLE_STATS.warrior;

          rooms[roomId] = {
            id: roomId,
            status: 'waiting',
            players: [
              {
                id: p1.id, ws: p1.ws, name: p1.name, role: p1.role, team: 'A',
                hp: stats1.hp, maxHp: stats1.hp, mp: stats1.mp, maxMp: stats1.mp,
                inventory: p1.user ? p1.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
              },
              {
                id: p2.id, ws: p2.ws, name: p2.name, role: p2.role, team: 'B',
                hp: stats2.hp, maxHp: stats2.hp, mp: stats2.mp, maxMp: stats2.mp,
                inventory: p2.user ? p2.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
              }
            ]
          };

          p1.ws.roomId = roomId;
          p2.ws.roomId = roomId;

          p1.ws.send(JSON.stringify({ type: 'match_found', roomId, player: rooms[roomId].players[0] }));
          p2.ws.send(JSON.stringify({ type: 'match_found', roomId, player: rooms[roomId].players[1] }));

          broadcastRoomState(roomId);
        }
      }

      // --- 取消匹配 ---
      else if (data.type === 'leave_queue') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        ws.isIdle = true;
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      // --- 自建房間 ---
      else if (data.type === 'create_room') {
        matchQueue = matchQueue.filter(p => p.ws !== ws); // 建房時先退出配對
        const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
        const role = data.role || 'warrior';
        const name = data.name || '勇者';
        const stats = ROLE_STATS[role] || ROLE_STATS.warrior;

        rooms[roomId] = {
          id: roomId,
          status: 'waiting',
          players: [{
            id: ws.id, ws, name, role, team: 'A',
            hp: stats.hp, maxHp: stats.hp, mp: stats.mp, maxMp: stats.mp,
            inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
          }]
        };

        ws.roomId = roomId;
        ws.isIdle = false;

        ws.send(JSON.stringify({ type: 'room_created', roomId, player: rooms[roomId].players[0] }));
        broadcastRoomState(roomId);
      }

      // --- 加入特定房間 ---
      else if (data.type === 'join_room') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        const { roomId, role, name } = data;
        const room = rooms[roomId];

        if (!room) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 找不到該房間號碼！' }));
        if (room.players.length >= 6) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該房間人數已滿！' }));

        const team = (room.players.filter(p => p.team === 'A').length <= room.players.filter(p => p.team === 'B').length) ? 'A' : 'B';
        const stats = ROLE_STATS[role] || ROLE_STATS.warrior;

        const newPlayer = {
          id: ws.id, ws, name: name || '勇者', role, team,
          hp: stats.hp, maxHp: stats.hp, mp: stats.mp, maxMp: stats.mp,
          inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
        };

        room.players.push(newPlayer);
        ws.roomId = roomId;
        ws.isIdle = false;

        ws.send(JSON.stringify({ type: 'room_joined', roomId, player: newPlayer }));
        broadcastRoomState(roomId);
      }

      // --- 開始遊戲 ---
      else if (data.type === 'start_game') {
        const room = rooms[ws.roomId];
        if (room) {
          room.status = 'playing';
          broadcastRoomState(room.id);
          broadcastBattleLog(room.id, "⚔️ 戰鬥開始！請雙方玩家開始發動技能！");
        }
      }

      // --- 釋放技能 ---
      else if (data.type === 'use_skill') {
        const room = rooms[ws.roomId];
        if (!room || room.status !== 'playing') return;

        const caster = room.players.find(p => p.id === ws.id);
        if (!caster || caster.hp <= 0) return;

        if (caster.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ MP 不足，無法釋放技能！' }));
        }

        caster.mp -= data.mpCost;
        let targets = [];

        if (data.isHeal) {
          targets = data.isAoe 
            ? room.players.filter(p => p.team === caster.team && p.hp > 0)
            : [room.players.find(p => p.id === data.targetId) || caster];
        } else {
          targets = data.isAoe
            ? room.players.filter(p => p.team !== caster.team && p.hp > 0)
            : [room.players.find(p => p.id === data.targetId) || room.players.find(p => p.team !== caster.team && p.hp > 0)];
        }

        targets = targets.filter(Boolean);

        targets.forEach(t => {
          const rawVal = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;
          if (data.isHeal) {
            t.hp = Math.min(t.maxHp, t.hp + rawVal);
            broadcastBattleLog(room.id, `💚 ${caster.name} 對 ${t.name} 使用了【${data.skillName}】，恢復了 ${rawVal} 點 HP！`);
          } else {
            t.hp = Math.max(0, t.hp - rawVal);
            broadcastBattleLog(room.id, `💥 ${caster.name} 對 ${t.name} 使用了【${data.skillName}】，造成了 ${rawVal} 點傷害！`);
          }
        });

        // 檢查勝負
        const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
        const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

        if (!teamAAlive || !teamBAlive) {
          room.status = 'game_over';
          const winner = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';
          broadcastBattleLog(room.id, `🏆 遊戲結束！【${winner}】獲得了最終勝利！`);
        }

        broadcastRoomState(room.id);
      }

      // --- 使用藥水 ---
      else if (data.type === 'use_potion') {
        const room = rooms[ws.roomId];
        if (!room) return;
        const p = room.players.find(p => p.id === ws.id);
        if (!p || p.hp <= 0) return;

        if (data.potionType === 'hp' && p.inventory.hpPotion > 0) {
          p.inventory.hpPotion--;
          p.hp = Math.min(p.maxHp, p.hp + 3000);
          broadcastBattleLog(room.id, `🧪 ${p.name} 使用了 HP 藥水，恢復了 3000 點生命值！`);
        } else if (data.potionType === 'mp' && p.inventory.mpPotion > 0) {
          p.inventory.mpPotion--;
          p.mp = Math.min(p.maxMp, p.mp + 1500);
          broadcastBattleLog(room.id, `🧪 ${p.name} 使用了 MP 藥水，恢復了 1500 點魔法值！`);
        }

        // 同步扣除後的背包回 DB
        if (ws.user) {
          ws.user.inventory = p.inventory;
          await pool.query(
            'UPDATE users SET hp_potion = $1, mp_potion = $2 WHERE id = $3',
            [p.inventory.hpPotion, p.inventory.mpPotion, ws.user.id]
          );
        }

        broadcastRoomState(room.id);
      }

      // --- 返回大廳 / 離開房間 ---
      else if (data.type === 'go_idle') {
        if (ws.roomId && rooms[ws.roomId]) {
          rooms[ws.roomId].players = rooms[ws.roomId].players.filter(p => p.id !== ws.id);
          if (rooms[ws.roomId].players.length === 0) {
            delete rooms[ws.roomId];
          } else {
            broadcastRoomState(ws.roomId);
          }
          ws.roomId = null;
        }
        ws.isIdle = true;
        ws.send(JSON.stringify({ type: 'returned_to_idle', message: '🧘 已回到大廳，繼續修練中...' }));
      }

    } catch (err) {
      console.error("解析訊息錯誤：", err);
    }
  });

  ws.on('close', () => {
    matchQueue = matchQueue.filter(p => p.ws !== ws);
    if (ws.roomId && rooms[ws.roomId]) {
      rooms[ws.roomId].players = rooms[ws.roomId].players.filter(p => p.id !== ws.id);
      if (rooms[ws.roomId].players.length === 0) {
        delete rooms[ws.roomId];
      } else {
        broadcastRoomState(ws.roomId);
      }
    }
  });
});

console.log(`🚀 RPG 遊戲伺服器已啟動於 Port ${PORT}`);
