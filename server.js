const http = require('http');
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

// 🏆 1. 段位計算邏輯 (8 大段位)
function getRankInfo(points) {
  const pts = points || 0;
  if (pts >= 3500) return { name: '璀璨之星', icon: '👑', color: '#ff1744' };
  if (pts >= 2700) return { name: '戰場傳說', icon: '⚔️', color: '#ff9100' };
  if (pts >= 2000) return { name: '星耀', icon: '🌟', color: '#e040fb' };
  if (pts >= 1400) return { name: '鑽石', icon: '💎', color: '#00e5ff' };
  if (pts >= 900)  return { name: '鉑金', icon: '🔷', color: '#00e676' };
  if (pts >= 500)  return { name: '黃金', icon: '🥇', color: '#ffd600' };
  if (pts >= 200)  return { name: '白銀', icon: '🥈', color: '#cfd8dc' };
  return { name: '青銅', icon: '🥉', color: '#a1887f' };
}

// 🗄️ 2. 初始化資料庫
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'berserker',
        hp_potion INT DEFAULT 5,
        mp_potion INT DEFAULT 5,
        exp_scroll INT DEFAULT 1,
        rank_points INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_points INT DEFAULT 0;
    `);

    console.log("🟢 資料庫連線並初始化成功！");
  } catch (err) {
    console.error("🔴 資料庫初始化失敗：", err);
  }
}
initDB();

// 🌐 3. 建立 HTTP 伺服器
const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Pong! RPG 遊戲伺服器運行中 🚀');
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ⚡ 4. WebSocket 伺服器設定
const wss = new WebSocket.Server({ server });
const rooms = {};
let matchQueue = [];

// 👥 在線人數模擬計數器 (基礎 350 人，於 300~500 間浮動)
let simulatedOnlineCount = 380;

const ROLE_STATS = {
  berserker: { hp: 16000, mp: 2000 },
  mage:      { hp: 9000,  mp: 5000 },
  priest:    { hp: 10000, mp: 4500 },
  knight:    { hp: 20000, mp: 1800 },
  assassin:  { hp: 11000, mp: 3000 },
  archer:    { hp: 10500, mp: 3200 }
};

// 廣播房間狀態
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
      inventory: p.inventory,
      statusEffects: p.statusEffects || {},
      rankPoints: p.rankPoints || 0,
      rankInfo: getRankInfo(p.rankPoints || 0)
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

// 💬 廣播大廳聊天訊息
function broadcastLobbyChat(senderName, message) {
  const payload = JSON.stringify({
    type: 'lobby_chat',
    sender: senderName,
    message: message,
    time: new Date().toLocaleTimeString('zh-TW', { hour12: false })
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.isIdle) {
      client.send(payload);
    }
  });
}

// 👥 廣播大廳在線人數
function broadcastOnlineCount() {
  // 讓人數在 300 ~ 500 之間隨機波動
  const fluctuation = Math.floor(Math.random() * 9) - 4; // -4 ~ +4
  simulatedOnlineCount = Math.max(300, Math.min(500, simulatedOnlineCount + fluctuation));
  const realCount = wss.clients.size;
  const totalDisplay = simulatedOnlineCount + realCount;

  const payload = JSON.stringify({
    type: 'online_count',
    onlineCount: totalDisplay
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 定時更新人數與心跳
setInterval(broadcastOnlineCount, 5000);

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// 🧘 掛機獎勵計時器
setInterval(async () => {
  for (let client of wss.clients) {
    if (client.readyState === WebSocket.OPEN && client.user && client.isIdle) {
      const isHp = Math.random() > 0.5;
      const col = isHp ? 'hp_potion' : 'mp_potion';
      const itemText = isHp ? 'HP 藥水 x1' : 'MP 藥水 x1';

      try {
        const res = await pool.query(
          `UPDATE users SET ${col} = ${col} + 1 WHERE id = $1 RETURNING hp_potion, mp_potion, exp_scroll, rank_points`,
          [client.user.id]
        );
        const inv = res.rows[0];
        client.user.inventory = {
          hpPotion: inv.hp_potion,
          mpPotion: inv.mp_potion,
          expScroll: inv.exp_scroll
        };
        client.user.rankPoints = inv.rank_points;

        client.send(JSON.stringify({
          type: 'idle_reward',
          message: `🧘 修練中... 獲得了 🧪 ${itemText}！`,
          inventory: client.user.inventory,
          rankPoints: client.user.rankPoints,
          rankInfo: getRankInfo(client.user.rankPoints)
        }));
      } catch (err) {
        console.error("掛機獎勵更新失敗:", err);
      }
    }
  }
}, 10000);

// 🎮 5. WebSocket 訊息處理
wss.on('connection', (ws) => {
  ws.id = 'PLAYER_' + Math.random().toString(36).substr(2, 9);
  ws.isIdle = true;
  ws.isAlive = true;

  // 剛連線時主動發送一次在線人數
  ws.send(JSON.stringify({ type: 'online_count', onlineCount: simulatedOnlineCount + wss.clients.size }));

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // --- 帳號註冊 ---
      if (data.type === 'register') {
        const { username, password } = data;
        const hash = await bcrypt.hash(password, 10);
        try {
          await pool.query('INSERT INTO users (username, password_hash, rank_points) VALUES ($1, $2, 0)', [username, hash]);
          ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功！預設段位為【🥉 青銅】。' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號名稱已被使用！' }));
        }
      }

      // --- 帳號登入 ---
      else if (data.type === 'login') {
        const { username, password } = data;
        const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (res.rows.length === 0) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));
        const user = res.rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));

        ws.user = {
          id: user.id,
          name: user.username,
          role: user.role,
          rankPoints: user.rank_points || 0,
          rankInfo: getRankInfo(user.rank_points || 0),
          inventory: { hpPotion: user.hp_potion, mpPotion: user.mp_potion, expScroll: user.exp_scroll }
        };
        ws.isIdle = true;

        ws.send(JSON.stringify({ type: 'login_success', user: ws.user }));
      }

      // 💬 --- 大廳聊天室訊息發送 ---
      else if (data.type === 'send_lobby_chat') {
        const senderName = (ws.user && ws.user.name) ? ws.user.name : (data.name || '勇者');
        if (data.message && data.message.trim() !== '') {
          broadcastLobbyChat(senderName, data.message.trim());
        }
      }

      // --- 1v1 隨機匹配 ---
      else if (data.type === 'join_queue') {
        matchQueue = matchQueue.filter(p => p.ws.readyState === WebSocket.OPEN && p.ws !== ws);

        const role = data.role || (ws.user ? ws.user.role : 'berserker');
        const name = data.name || (ws.user ? ws.user.name : '勇者');
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        matchQueue.push({ ws, id: ws.id, name, role, rankPoints: rankPts, user: ws.user });
        ws.isIdle = false;
        ws.send(JSON.stringify({ type: 'queue_joined' }));

        if (matchQueue.length >= 2) {
          const p1 = matchQueue.shift();
          const p2 = matchQueue.shift();
          const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
          const stats1 = ROLE_STATS[p1.role] || ROLE_STATS.berserker;
          const stats2 = ROLE_STATS[p2.role] || ROLE_STATS.berserker;

          rooms[roomId] = {
            id: roomId,
            status: 'waiting',
            regenTimer: null,
            players: [
              {
                id: p1.id, ws: p1.ws, name: p1.name, role: p1.role, team: 'A',
                hp: stats1.hp, maxHp: stats1.hp, mp: stats1.mp, maxMp: stats1.mp,
                rankPoints: p1.rankPoints, statusEffects: {},
                inventory: p1.user ? p1.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
              },
              {
                id: p2.id, ws: p2.ws, name: p2.name, role: p2.role, team: 'B',
                hp: stats2.hp, maxHp: stats2.hp, mp: stats2.mp, maxMp: stats2.mp,
                rankPoints: p2.rankPoints, statusEffects: {},
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
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
        const role = data.role || 'berserker';
        const name = data.name || '勇者';
        const team = data.team || 'A'; // 自選初始隊伍
        const stats = ROLE_STATS[role] || ROLE_STATS.berserker;
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        rooms[roomId] = {
          id: roomId,
          status: 'waiting',
          regenTimer: null,
          players: [{
            id: ws.id, ws, name, role, team,
            hp: stats.hp, maxHp: stats.hp, mp: stats.mp, maxMp: stats.mp,
            rankPoints: rankPts, statusEffects: {},
            inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
          }]
        };

        ws.roomId = roomId;
        ws.isIdle = false;
        ws.send(JSON.stringify({ type: 'room_created', roomId, player: rooms[roomId].players[0] }));
        broadcastRoomState(roomId);
      }

      // 🚩 --- 加入房間 (可自選隊伍) ---
      else if (data.type === 'join_room') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        const { roomId, role, name, targetTeam } = data;
        const room = rooms[roomId];

        if (!room) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 找不到該房間號碼！' }));
        if (room.players.length >= 6) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該房間人數已滿！' }));

        // 判定選擇的隊伍
        let assignedTeam = targetTeam || 'A';
        const teamCount = room.players.filter(p => p.team === assignedTeam).length;
        if (teamCount >= 3) {
          // 若目標隊伍滿了則分配到另一隊
          assignedTeam = assignedTeam === 'A' ? 'B' : 'A';
        }

        const stats = ROLE_STATS[role] || ROLE_STATS.berserker;
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        const newPlayer = {
          id: ws.id, ws, name: name || '勇者', role, team: assignedTeam,
          hp: stats.hp, maxHp: stats.hp, mp: stats.mp, maxMp: stats.mp,
          rankPoints: rankPts, statusEffects: {},
          inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1 }
        };

        room.players.push(newPlayer);
        ws.roomId = roomId;
        ws.isIdle = false;

        ws.send(JSON.stringify({ type: 'room_joined', roomId, player: newPlayer }));
        broadcastRoomState(roomId);
      }

      // 🚩 --- 房間內切換隊伍 ---
      else if (data.type === 'switch_team') {
        const room = rooms[ws.roomId];
        if (!room || room.status !== 'waiting') return;
        const p = room.players.find(p => p.id === ws.id);
        if (!p) return;

        const targetTeam = data.targetTeam; // 'A' 或 'B'
        const count = room.players.filter(pl => pl.team === targetTeam).length;
        if (count >= 3) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該隊伍人數已滿！' }));
        }

        p.team = targetTeam;
        broadcastBattleLog(room.id, `🔄 ${p.name} 切換到了 隊伍 ${targetTeam}！`);
        broadcastRoomState(room.id);
      }

      // 💧 --- 開始遊戲 (含每秒自動恢復 MP 機能) ---
      else if (data.type === 'start_game') {
        const room = rooms[ws.roomId];
        if (room && room.status === 'waiting') {
          room.status = 'playing';

          // 💧 啟動每秒恢復 50 MP 的計時器
          room.regenTimer = setInterval(() => {
            if (!rooms[room.id] || room.status !== 'playing') {
              clearInterval(room.regenTimer);
              return;
            }

            let updated = false;
            room.players.forEach(p => {
              if (p.hp > 0 && p.mp < p.maxMp) {
                p.mp = Math.min(p.maxMp, p.mp + 50); // 每秒回復 50 MP
                updated = true;
              }
            });

            if (updated) {
              broadcastRoomState(room.id);
            }
          }, 1000);

          broadcastRoomState(room.id);
          broadcastBattleLog(room.id, "⚔️ 戰鬥開始！每秒會自動回復 50 魔力 (MP)！");
        }
      }

      // --- 釋放技能與戰鬥結算 ---
      else if (data.type === 'use_skill') {
        const room = rooms[ws.roomId];
        if (!room || room.status !== 'playing') return;

        const caster = room.players.find(p => p.id === ws.id);
        if (!caster || caster.hp <= 0) return;

        if (caster.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ MP 不足，無法釋放技能！' }));
        }

        // 致盲判定
        if (caster.statusEffects && caster.statusEffects.blind && Math.random() < 0.5) {
          caster.mp -= data.mpCost;
          broadcastBattleLog(room.id, `👁️ ${caster.name} 受致盲影響，技能 MISS！`);
          broadcastRoomState(room.id);
          return;
        }

        caster.mp -= data.mpCost;

        // 復活術處理
        if (data.isRevive) {
          let deadTeammates = room.players.filter(p => p.team === caster.team && p.hp <= 0);
          let reviveTarget = data.targetId ? deadTeammates.find(p => p.id === data.targetId) : deadTeammates[0];

          if (reviveTarget) {
            reviveTarget.hp = Math.floor(reviveTarget.maxHp * 0.3);
            reviveTarget.statusEffects = {};
            broadcastBattleLog(room.id, `🌟 ${caster.name} 復活了 ${reviveTarget.name}！`);
          } else {
            broadcastBattleLog(room.id, `🌟 ${caster.name} 使用了【${data.skillName}】，但無可復活隊友！`);
          }
          broadcastRoomState(room.id);
          return;
        }

        let targets = data.isHeal
          ? (data.isAoe ? room.players.filter(p => p.team === caster.team && p.hp > 0) : [room.players.find(p => p.id === data.targetId) || caster])
          : (data.isAoe ? room.players.filter(p => p.team !== caster.team && p.hp > 0) : [room.players.find(p => p.id === data.targetId) || room.players.find(p => p.team !== caster.team && p.hp > 0)]);

        targets = targets.filter(Boolean);
        let totalDamageDealt = 0;

        targets.forEach(t => {
          const rawVal = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;

          if (data.isHeal) {
            t.hp = Math.min(t.maxHp, t.hp + rawVal);
            broadcastBattleLog(room.id, `💚 ${caster.name} 對 ${t.name} 使用【${data.skillName}】，恢復 ${rawVal} HP！`);
          } else {
            t.hp = Math.max(0, t.hp - rawVal);
            totalDamageDealt += rawVal;
            broadcastBattleLog(room.id, `💥 ${caster.name} 對 ${t.name} 使用【${data.skillName}】，造成 ${rawVal} 傷害！`);

            // 騎士 5% 荊棘反傷
            if (t.role === 'knight' && rawVal > 0) {
              const reflectDmg = Math.floor(rawVal * 0.05);
              caster.hp = Math.max(0, caster.hp - reflectDmg);
              broadcastBattleLog(room.id, `🏰 ${t.name} (騎士) 荊棘反傷，反彈 ${reflectDmg} 傷害！`);
            }

            // 異常狀態判定
            if (data.effect && Math.random() < (data.chance || 0)) {
              t.statusEffects = t.statusEffects || {};
              t.statusEffects[data.effect] = true;
              const effectNames = { burn: '🔥【灼燒】', paralyze: '⚡【麻痺】', poison: '☠️【中毒】', blind: '👁️【致盲】' };
              broadcastBattleLog(room.id, `✨ ${t.name} 陷入了 ${effectNames[data.effect] || data.effect}！`);

              setTimeout(() => {
                if (t.statusEffects) {
                  t.statusEffects[data.effect] = false;
                  if (rooms[room.id]) broadcastRoomState(room.id);
                }
              }, 5000);
            }
          }
        });

        // 狂戰士吸血
        if (data.lifesteal && totalDamageDealt > 0 && caster.hp > 0) {
          const lifestealAmount = Math.floor(totalDamageDealt * data.lifesteal);
          caster.hp = Math.min(caster.maxHp, caster.hp + lifestealAmount);
          broadcastBattleLog(room.id, `🩸 ${caster.name} 吸血回復了 ${lifestealAmount} HP！`);
        }

        // 🏆 檢查勝負
        const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
        const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

        if (!teamAAlive || !teamBAlive) {
          room.status = 'game_over';
          if (room.regenTimer) clearInterval(room.regenTimer); // 停止 MP 回復

          const winTeam = teamAAlive ? 'A' : 'B';
          const winTeamName = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';

          broadcastBattleLog(room.id, `🏆 遊戲結束！【${winTeamName}】獲得了最終勝利！`);

          for (let p of room.players) {
            const isWinner = (p.team === winTeam);
            const delta = isWinner ? 25 : -15;

            p.rankPoints = Math.max(0, (p.rankPoints || 0) + delta);
            const rInfo = getRankInfo(p.rankPoints);

            broadcastBattleLog(room.id, `🎖️ ${p.name} (${isWinner ? '獲勝' : '戰敗'})：積分 ${delta > 0 ? '+' + delta : delta} (總分: ${p.rankPoints} - ${rInfo.icon} ${rInfo.name})`);

            if (p.ws && p.ws.user) {
              p.ws.user.rankPoints = p.rankPoints;
              try {
                await pool.query('UPDATE users SET rank_points = $1 WHERE id = $2', [p.rankPoints, p.ws.user.id]);
              } catch (e) {
                console.error("更新段位積分失敗:", e);
              }
            }
          }
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
          broadcastBattleLog(room.id, `🧪 ${p.name} 使用了 HP 藥水！`);
        } else if (data.potionType === 'mp' && p.inventory.mpPotion > 0) {
          p.inventory.mpPotion--;
          p.mp = Math.min(p.maxMp, p.mp + 1500);
          broadcastBattleLog(room.id, `🧪 ${p.name} 使用了 MP 藥水！`);
        }

        if (ws.user) {
          ws.user.inventory = p.inventory;
          await pool.query('UPDATE users SET hp_potion = $1, mp_potion = $2 WHERE id = $3', [p.inventory.hpPotion, p.inventory.mpPotion, ws.user.id]);
        }

        broadcastRoomState(room.id);
      }

      // --- 返回大廳 ---
      else if (data.type === 'go_idle') {
        if (ws.roomId && rooms[ws.roomId]) {
          const room = rooms[ws.roomId];
          room.players = room.players.filter(p => p.id !== ws.id);
          if (room.players.length === 0) {
            if (room.regenTimer) clearInterval(room.regenTimer);
            delete rooms[ws.roomId];
          } else {
            broadcastRoomState(ws.roomId);
          }
          ws.roomId = null;
        }
        ws.isIdle = true;
        ws.send(JSON.stringify({ type: 'returned_to_idle', message: '🧘 已回到大廳修練...' }));
      }

    } catch (err) {
      console.error("解析訊息錯誤：", err);
    }
  });

  ws.on('close', () => {
    matchQueue = matchQueue.filter(p => p.ws !== ws);
    if (ws.roomId && rooms[ws.roomId]) {
      const room = rooms[ws.roomId];
      room.players = room.players.filter(p => p.id !== ws.id);
      if (room.players.length === 0) {
        if (room.regenTimer) clearInterval(room.regenTimer);
        delete rooms[ws.roomId];
      } else {
        broadcastRoomState(ws.roomId);
      }
    }
  });
});

process.on('uncaughtException', (err) => console.error('💥 未處理錯誤:', err));
process.on('unhandledRejection', (reason) => console.error('💥 未處理 Promise 拒絕:', reason));

server.listen(PORT, () => {
  console.log(`🚀 RPG 遊戲伺服器已啟動於 Port ${PORT}`);
});
