const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('RPG WebSocket Server is running.');
});

const wss = new WebSocket.Server({ server });

// ------------------------------------------------------------------
// 1. 資料持久化 (用戶帳號與資料庫)
// ------------------------------------------------------------------
const DB_FILE = path.join(__dirname, 'users.json');
let usersDB = {};

function loadUsers() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      usersDB = JSON.parse(data);
    }
  } catch (err) {
    console.error('讀取用戶資料庫失敗:', err);
    usersDB = {};
  }
}

function saveUsers() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(usersDB, null, 2), 'utf8');
  } catch (err) {
    console.error('儲存用戶資料庫失敗:', err);
  }
}

loadUsers();

// ------------------------------------------------------------------
// 2. 全域狀態管理
// ------------------------------------------------------------------
const clients = new Map(); // ws -> clientData
const matchmakingQueue = []; // 配對隊列
const rooms = new Map(); // roomId -> roomData

// 職業基礎設定 (最高血量與魔力)
const ROLE_STATS = {
  berserker: { maxHp: 16000, maxMp: 1000 },
  mage:      { maxHp: 9000,  maxMp: 1500 },
  priest:    { maxHp: 10000, maxMp: 1400 },
  knight:    { maxHp: 20000, maxMp: 800  },
  assassin:  { maxHp: 11000, maxMp: 1100 },
  archer:    { maxHp: 10500, maxMp: 1200 }
};

function getRankInfo(level) {
  if (level >= 30) return { name: '王者', icon: '👑' };
  if (level >= 20) return { name: '大師', icon: '💎' };
  if (level >= 15) return { name: '鑽石', icon: '🔷' };
  if (level >= 10) return { name: '黃金', icon: '🥇' };
  if (level >= 5)  return { name: '白銀', icon: '🥈' };
  return { name: '青銅', icon: '🥉' };
}

// ------------------------------------------------------------------
// 3. 定時器：大廳掛機獎勵 & 戰鬥中每秒 MP 回復 / 狀態扣血
// ------------------------------------------------------------------
setInterval(() => {
  // 廣播在大廳的玩家人數
  const onlineCount = wss.clients.size;
  broadcast({ type: 'online_count', onlineCount });

  // 大廳掛機獎勵 (每 15 秒發放一次)
  const now = Date.now();
  for (const [ws, client] of clients.entries()) {
    if (client.username && !client.roomId && (now - client.lastIdleRewardTime > 15000)) {
      client.lastIdleRewardTime = now;
      giveIdleReward(ws, client);
    }
  }
}, 5000);

// 戰鬥邏輯循環 (每 1 秒)
setInterval(() => {
  for (const [roomId, room] of rooms.entries()) {
    if (room.status !== 'playing') continue;

    let updated = false;

    room.players.forEach(p => {
      if (p.hp > 0) {
        // 每秒自然回魔 +50 MP
        if (p.mp < p.maxMp) {
          p.mp = Math.min(p.maxMp, p.mp + 50);
          updated = true;
        }

        // 狀態異常處理 (灼燒 / 中毒)
        if (p.statusEffects) {
          if (p.statusEffects.burn) {
            const burnDmg = 150;
            p.hp = Math.max(0, p.hp - burnDmg);
            broadcastToRoom(room, { type: 'battle_log', message: `🔥 ${p.name} 受到灼燒傷害 ${burnDmg} 點！` });
            updated = true;
          }
          if (p.statusEffects.poison) {
            const poisonDmg = 200;
            p.hp = Math.max(0, p.hp - poisonDmg);
            broadcastToRoom(room, { type: 'battle_log', message: `☠️ ${p.name} 受到劇毒傷害 ${poisonDmg} 點！` });
            updated = true;
          }
        }
      }
    });

    if (updated) {
      checkGameEnd(room);
      broadcastRoomState(room);
    }
  }
}, 1000);

function giveIdleReward(ws, client) {
  const user = usersDB[client.username];
  if (!user) return;

  const rand = Math.random();
  let msg = '';
  let gainedExp = 0;

  if (rand < 0.4) {
    user.gold = (user.gold || 0) + 30;
    msg = "🧘‍♂️ 自動修練完成，獲得了 30 金幣！";
  } else if (rand < 0.7) {
    gainedExp = 40;
    user.exp = (user.exp || 0) + gainedExp;
    msg = `🧘‍♂️ 自動修練完成，吸收天地靈氣獲得了 ${gainedExp} 點經驗值！`;
  } else if (rand < 0.85) {
    user.inventory.hpPotion = (user.inventory.hpPotion || 0) + 1;
    msg = "🧘‍♂️ 自動修練時幸運撿到了 1 瓶 🧪 HP 藥水！";
  } else {
    user.inventory.mpPotion = (user.inventory.mpPotion || 0) + 1;
    msg = "🧘‍♂️ 自動修練時幸運撿到了 1 瓶 🧪 MP 藥水！";
  }

  saveUsers();
  sendTo(ws, {
    type: 'idle_reward',
    message: msg,
    gainedExp,
    inventory: user.inventory
  });
}

// ------------------------------------------------------------------
// 4. WebSocket 訊息處理主邏輯
// ------------------------------------------------------------------
wss.on('connection', (ws) => {
  const clientData = {
    id: generateId(),
    username: null,
    roomId: null,
    lastIdleRewardTime: Date.now()
  };
  clients.set(ws, clientData);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleClientMessage(ws, clientData, data);
    } catch (e) {
      console.error('無效的 JSON 訊息:', e);
    }
  });

  ws.on('close', () => {
    removeFromQueue(ws);
    leaveCurrentRoom(ws, clientData);
    clients.delete(ws);
  });
});

function handleClientMessage(ws, client, data) {
  switch (data.type) {
    // ---------------- 帳號與登入 ----------------
    case 'register': {
      if (usersDB[data.username]) {
        return sendTo(ws, { type: 'error', message: '帳號已存在！' });
      }
      usersDB[data.username] = {
        password: data.password,
        name: data.username,
        role: 'berserker',
        level: 1,
        exp: 0,
        gold: 100,
        inventory: { gold: 100, hpPotion: 2, mpPotion: 2, expScroll: 1 }
      };
      saveUsers();
      sendTo(ws, { type: 'register_success', message: '🎉 註冊成功，請登入！' });
      break;
    }

    case 'login': {
      const user = usersDB[data.username];
      if (!user || user.password !== data.password) {
        return sendTo(ws, { type: 'error', message: '帳號或密碼錯誤！' });
      }
      client.username = data.username;
      sendTo(ws, {
        type: 'login_success',
        user: {
          name: user.name,
          role: user.role,
          level: user.level,
          exp: user.exp,
          inventory: user.inventory
        }
      });
      break;
    }

    case 'send_lobby_chat': {
      const time = new Date().toLocaleTimeString();
      broadcast({
        type: 'lobby_chat',
        sender: data.name || client.username || '匿名勇者',
        message: data.message,
        time
      });
      break;
    }

    case 'buy_item': {
      if (!client.username) return;
      const user = usersDB[client.username];
      if (!user) return;

      if ((user.inventory.gold || 0) >= data.price) {
        user.inventory.gold -= data.price;
        user.inventory[data.itemKey] = (user.inventory[data.itemKey] || 0) + 1;
        saveUsers();
      }
      break;
    }

    // ---------------- 匹配與房間管理 ----------------
    case 'join_queue': {
      removeFromQueue(ws);
      matchmakingQueue.push({ ws, client, name: data.name, role: data.role, level: data.level || 1 });
      sendTo(ws, { type: 'queue_joined' });
      checkMatchmaking();
      break;
    }

    case 'leave_queue': {
      removeFromQueue(ws);
      sendTo(ws, { type: 'queue_left' });
      break;
    }

    case 'create_room': {
      leaveCurrentRoom(ws, client);
      const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
      const player = createPlayerObject(client.id, data.name, data.role, data.team || 'A', data.level, client.username);
      
      const room = {
        id: roomId,
        status: 'waiting',
        players: [player]
      };
      rooms.set(roomId, room);
      client.roomId = roomId;

      sendTo(ws, { type: 'room_created', roomId, player });
      broadcastRoomState(room);
      break;
    }

    case 'join_room': {
      leaveCurrentRoom(ws, client);
      const room = rooms.get(data.roomId);
      if (!room) return sendTo(ws, { type: 'error', message: '找不到該房間！' });
      if (room.status !== 'waiting') return sendTo(ws, { type: 'error', message: '戰鬥已在進行中，無法加入！' });

      const player = createPlayerObject(client.id, data.name, data.role, data.targetTeam || 'B', data.level, client.username);
      room.players.push(player);
      client.roomId = roomId;

      sendTo(ws, { type: 'room_joined', roomId: data.roomId, player });
      broadcastRoomState(room);
      break;
    }

    case 'switch_team': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'waiting') return;
      const player = room.players.find(p => p.id === client.id);
      if (player) {
        player.team = data.targetTeam;
        broadcastRoomState(room);
      }
      break;
    }

    case 'start_game': {
      const room = rooms.get(client.roomId);
      if (!room) return;
      
      const hasTeamA = room.players.some(p => p.team === 'A');
      const hasTeamB = room.players.some(p => p.team === 'B');
      if (!hasTeamA || !hasTeamB) {
        return sendTo(ws, { type: 'error', message: '兩隊皆需要至少一名玩家才能開始遊戲！' });
      }

      room.status = 'playing';
      broadcastToRoom(room, { type: 'battle_log', message: '⚔️ 戰鬥正式開始！準備釋放技能！' });
      broadcastRoomState(room);
      break;
    }

    case 'use_skill': {
      const room = rooms.get(client.roomId);
      if (!room || room.status !== 'playing') return;

      const caster = room.players.find(p => p.id === client.id);
      if (!caster || caster.hp <= 0) return;
      if (caster.mp < data.mpCost) return sendTo(ws, { type: 'error', message: 'MP 不足！' });

      // 麻痺檢查 (25% 機率無法行動)
      if (caster.statusEffects && caster.statusEffects.paralyze && Math.random() < 0.25) {
        broadcastToRoom(room, { type: 'battle_log', message: `⚡ ${caster.name} 受到【麻痺】影響，無法動彈！` });
        return;
      }

      // 扣除 MP
      caster.mp -= data.mpCost;

      // 處理復活術
      if (data.isRevive) {
        let deadAlly = room.players.find(p => p.id === data.targetId && p.team === caster.team && p.hp <= 0);
        if (!deadAlly) {
          deadAlly = room.players.find(p => p.team === caster.team && p.hp <= 0);
        }
        if (deadAlly) {
          deadAlly.hp = Math.floor(deadAlly.maxHp * 0.5);
          broadcastToRoom(room, { type: 'battle_log', message: `🌟 ${caster.name} 施展了【復活術】，成功復活了 ${deadAlly.name}！` });
        } else {
          broadcastToRoom(room, { type: 'battle_log', message: `🌟 ${caster.name} 施展了【復活術】，但沒有可復活的隊友。` });
        }
        broadcastRoomState(room);
        return;
      }

      // 戰鬥數據計算 (傷害/治癒)
      const baseVal = Math.floor(data.minVal + Math.random() * (data.maxVal - data.minVal + 1));
      const isCrit = Math.random() < 0.2;
      const finalVal = isCrit ? Math.floor(baseVal * 1.5) : baseVal;

      let logPrefix = data.isUlt ? '💥【大招！】' : '';
      if (isCrit) logPrefix += '💥【暴擊！】';

      if (data.isHeal) {
        // 治癒邏輯
        let targets = [];
        if (data.isAoe) {
          targets = room.players.filter(p => p.team === caster.team && p.hp > 0);
        } else {
          let t = room.players.find(p => p.id === data.targetId && p.team === caster.team && p.hp > 0);
          if (!t) t = caster;
          targets = [t];
        }

        targets.forEach(t => {
          t.hp = Math.min(t.maxHp, t.hp + finalVal);
          broadcastToRoom(room, { type: 'battle_log', message: `${logPrefix}💚 ${caster.name} 對 ${t.name} 使用 ${data.skillName}，恢復了 ${finalVal} 點 HP！` });
        });
      } else {
        // 攻擊邏輯
        let targets = [];
        const enemies = room.players.filter(p => p.team !== caster.team && p.hp > 0);

        if (enemies.length === 0) return;

        if (data.isAoe) {
          targets = enemies;
        } else {
          let t = enemies.find(p => p.id === data.targetId);
          if (!t) t = enemies[0]; // 自動選擇第一個存活敵人
          targets = [t];
        }

        let totalDamageDealt = 0;

        targets.forEach(t => {
          // 致盲檢查 (MISS 概率)
          if (caster.statusEffects && caster.statusEffects.blind && Math.random() < 0.4) {
            broadcastToRoom(room, { type: 'battle_log', message: `👁️ ${caster.name} 因【致盲】影響，攻擊 MISS 了！` });
            return;
          }

          let dmg = finalVal;
          t.hp = Math.max(0, t.hp - dmg);
          totalDamageDealt += dmg;

          // 騎士反傷 (5%)
          if (t.role === 'knight') {
            const reflectDmg = Math.floor(dmg * 0.05);
            caster.hp = Math.max(0, caster.hp - reflectDmg);
            broadcastToRoom(room, { type: 'battle_log', message: `🛡️ ${t.name} 的騎士盾牌觸發反傷，對 ${caster.name} 反彈了 ${reflectDmg} 點傷害！` });
          }

          // 狀態效果施加
          if (data.effect && Math.random() < (data.chance || 0.3)) {
            if (!t.statusEffects) t.statusEffects = {};
            t.statusEffects[data.effect] = true;
            broadcastToRoom(room, { type: 'battle_log', message: `✨ ${t.name} 陷入了【${getStatusName(data.effect)}】狀態！` });
          }

          broadcastToRoom(room, { type: 'battle_log', message: `${logPrefix}⚔️ ${caster.name} 對 ${t.name} 施展 ${data.skillName}，造成 ${dmg} 點傷害！` });
        });

        // 吸血效果
        if (data.lifesteal && totalDamageDealt > 0) {
          const healAmt = Math.floor(totalDamageDealt * data.lifesteal);
          caster.hp = Math.min(caster.maxHp, caster.hp + healAmt);
          broadcastToRoom(room, { type: 'battle_log', message: `🩸 ${caster.name} 觸發吸血，恢復了 ${healAmt} 點 HP！` });
        }
      }

      checkGameEnd(room);
      broadcastRoomState(room);
      break;
    }

    case 'use_potion': {
      const room = rooms.get(client.roomId);
      if (!client.username) return;
      const user = usersDB[client.username];
      if (!user) return;

      const player = room ? room.players.find(p => p.id === client.id) : null;

      if (data.potionType === 'hp') {
        if ((user.inventory.hpPotion || 0) > 0) {
          user.inventory.hpPotion -= 1;
          if (player) {
            player.hp = Math.min(player.maxHp, player.hp + 3000);
            broadcastToRoom(room, { type: 'battle_log', message: `🧪 ${player.name} 使用了 HP 藥水，恢復了 3000 點生命值！` });
          }
        }
      } else if (data.potionType === 'mp') {
        if ((user.inventory.mpPotion || 0) > 0) {
          user.inventory.mpPotion -= 1;
          if (player) {
            player.mp = Math.min(player.maxMp, player.mp + 500);
            broadcastToRoom(room, { type: 'battle_log', message: `🧪 ${player.name} 使用了 MP 藥水，恢復了 500 點魔力值！` });
          }
        }
      }

      saveUsers();
      if (player) player.inventory = user.inventory;
      if (room) broadcastRoomState(room);
      break;
    }

    case 'rematch': {
      const room = rooms.get(client.roomId);
      if (!room) return;

      room.status = 'waiting';
      room.players.forEach(p => {
        p.hp = p.maxHp;
        p.mp = p.maxMp;
        p.statusEffects = {};
      });
      broadcastToRoom(room, { type: 'battle_log', message: '🔄 隊長重新開局，等待開始戰鬥！' });
      broadcastRoomState(room);
      break;
    }

    case 'go_idle': {
      leaveCurrentRoom(ws, client);
      sendTo(ws, { type: 'returned_to_idle', message: '🧘‍♂️ 已返回大廳繼續修練。' });
      break;
    }
  }
}

// ------------------------------------------------------------------
// 輔助函式
// ------------------------------------------------------------------
function createPlayerObject(id, name, role, team, level = 1, username = null) {
  const stats = ROLE_STATS[role] || ROLE_STATS['berserker'];
  const userInv = (username && usersDB[username]) ? usersDB[username].inventory : { gold: 0, hpPotion: 0, mpPotion: 0, expScroll: 0 };
  
  return {
    id,
    name: name || '勇者',
    role,
    team,
    level,
    rankInfo: getRankInfo(level),
    maxHp: stats.maxHp,
    hp: stats.maxHp,
    maxMp: stats.maxMp,
    mp: stats.maxMp,
    inventory: userInv,
    statusEffects: {}
  };
}

function checkMatchmaking() {
  if (matchmakingQueue.length >= 2) {
    const p1 = matchmakingQueue.shift();
    const p2 = matchmakingQueue.shift();

    const roomId = 'MATCH_' + Math.floor(1000 + Math.random() * 9000);
    const player1 = createPlayerObject(p1.client.id, p1.name, p1.role, 'A', p1.level, p1.client.username);
    const player2 = createPlayerObject(p2.client.id, p2.name, p2.role, 'B', p2.level, p2.client.username);

    const room = {
      id: roomId,
      status: 'playing',
      players: [player1, player2]
    };

    rooms.set(roomId, room);
    p1.client.roomId = roomId;
    p2.client.roomId = roomId;

    sendTo(p1.ws, { type: 'match_found', roomId, player: player1 });
    sendTo(p2.ws, { type: 'match_found', roomId, player: player2 });

    broadcastToRoom(room, { type: 'battle_log', message: '🎉 單人隨機配對成功！戰鬥開始！' });
    broadcastRoomState(room);
  }
}

function checkGameEnd(room) {
  if (room.status !== 'playing') return;

  const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
  const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

  if (!teamAAlive || !teamBAlive) {
    room.status = 'game_over';
    const winTeam = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';
    broadcastToRoom(room, { type: 'battle_log', message: `🏆 戰鬥結束！勝者是 ${winTeam}！` });

    // 結算獎勵 (獲勝隊伍獲得金幣與經驗)
    room.players.forEach(p => {
      const isWinner = (teamAAlive && p.team === 'A') || (teamBAlive && p.team === 'B');
      const wsClient = Array.from(clients.entries()).find(([_, c]) => c.id === p.id);

      if (wsClient && wsClient[1].username) {
        const u = usersDB[wsClient[1].username];
        if (u) {
          const goldEarned = isWinner ? 100 : 30;
          const expEarned = isWinner ? 120 : 40;
          u.inventory.gold = (u.inventory.gold || 0) + goldEarned;
          u.exp = (u.exp || 0) + expEarned;
          saveUsers();

          sendTo(wsClient[0], {
            type: 'idle_reward',
            message: `🎉 戰鬥結算：獲得金幣 +${goldEarned}，經驗值 +${expEarned}！`,
            gainedExp: expEarned,
            inventory: u.inventory
          });
        }
      }
    });
  }
}

function removeFromQueue(ws) {
  const idx = matchmakingQueue.findIndex(item => item.ws === ws);
  if (idx !== -1) matchmakingQueue.splice(idx, 1);
}

function leaveCurrentRoom(ws, client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  if (room) {
    room.players = room.players.filter(p => p.id !== client.id);
    if (room.players.length === 0) {
      rooms.delete(client.roomId);
    } else {
      broadcastToRoom(room, { type: 'battle_log', message: `🚪 有玩家離開了房間。` });
      checkGameEnd(room);
      broadcastRoomState(room);
    }
  }
  client.roomId = null;
}

function broadcastRoomState(room) {
  broadcastToRoom(room, {
    type: 'room_state',
    roomId: room.id,
    status: room.status,
    players: room.players
  });
}

function broadcastToRoom(room, data) {
  const jsonStr = JSON.stringify(data);
  for (const [ws, client] of clients.entries()) {
    if (client.roomId === room.id && ws.readyState === WebSocket.OPEN) {
      ws.send(jsonStr);
    }
  }
}

function broadcast(data) {
  const jsonStr = JSON.stringify(data);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(jsonStr);
    }
  }
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getStatusName(effect) {
  switch (effect) {
    case 'burn': return '🔥 灼燒';
    case 'paralyze': return '⚡ 麻痺';
    case 'poison': return '☠️ 中毒';
    case 'blind': return '👁️ 致盲';
    default: return '異常';
  }
}

function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

server.listen(PORT, () => {
  console.log(`🚀 RPG 伺服器已成功運行在埠號 ${PORT}`);
});
