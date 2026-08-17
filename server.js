const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 8080;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// 🏆 段位計算邏輯
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

// 🗄️ 初始化資料庫
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name TEXT,
        role VARCHAR(20) DEFAULT 'berserker',
        hp_potion INT DEFAULT 5,
        mp_potion INT DEFAULT 5,
        exp_scroll INT DEFAULT 1,
        gold INT DEFAULT 0,
        level INT DEFAULT 1,
        exp INT DEFAULT 0,
        rank_points INT DEFAULT 0,
        stat_points INT DEFAULT 0,
        str INT DEFAULT 0,
        int_stat INT DEFAULT 0,
        vit INT DEFAULT 0,
        agi INT DEFAULT 0,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 檢查並補齊可能缺少的欄位
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rank_points INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gold INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INT DEFAULT 1;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exp INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stat_points INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS str INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS int_stat INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS vit INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS agi INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;`);

    // 👑 自動將「空白」帳號設為管理員
    await pool.query("UPDATE users SET is_admin = TRUE WHERE username = '空白'");

    console.log("🟢 資料庫連線並初始化成功！");
  } catch (err) {
    console.error("🔴 資料庫初始化失敗：", err);
  }
}
initDB();

const server = http.createServer((req, res) => {
  if (req.url === '/ping' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Pong! RPG 遊戲伺服器運行中 🚀');
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocket.Server({ server });
const rooms = {};
let matchQueue = [];
let matchQueue5v5 = []; // 👥 5V5 專用匹配佇列
let simulatedOnlineCount = 5501;

// 暫存待審核的儲值申請佇列
let pendingTopups = [];

const ROLE_STATS = {
  berserker: { hp: 16000, mp: 2000 },
  mage:      { hp: 9000,  mp: 5000 },
  priest:    { hp: 10000, mp: 4500 },
  knight:    { hp: 20000, mp: 1800 },
  assassin:  { hp: 11000, mp: 3000 },
  archer:    { hp: 10500, mp: 3200 }
};

// 🎭 逼真的對手暱稱庫
const AI_NAMES = ["影流之主", "孤高劍士", "夜之狂刃", "星空幻影", "無雙戰神", "疾風之流", "聖光裁決","追風少年","哈雷路亞","卡比之星","全都是垃圾","若基","買幣","傻D","零度", "浅笑安然", "Mia", "Zoe", "Leo_x", "Ray_Zero", "Luna_Moon", "小狂神", "傲氣雄鷹", "夢幻神話"];
const ALL_ROLES = ['berserker', 'mage', 'priest', 'knight', 'assassin', 'archer'];

function getNextExpReq(level) {
  return Math.floor(100 * Math.pow(level, 1.5));
}

function getCalculatedMaxHp(role, vit) {
  const baseHp = (ROLE_STATS[role] || ROLE_STATS.berserker).hp;
  return baseHp + ((vit || 0) * 150);
}

function applyDefenseReduction(rawDamage, targetVit) {
  const defense = (targetVit || 0) * 5;
  const damageMultiplier = 100 / (100 + defense);
  return Math.max(1, Math.floor(rawDamage * damageMultiplier));
}

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
      level: p.level || 1,
      stats: p.stats || { statPoints: 0, str: 0, int: 0, vit: 0, agi: 0 },
      inventory: p.inventory,
      statusEffects: p.statusEffects || {},
      cooldowns: p.cooldowns || {},
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

function broadcastLobbyChat(senderName, message) {
  const payload = JSON.stringify({
    type: 'lobby_chat',
    sender: senderName,
    message: message,
    time: new Date().toLocaleTimeString('zh-TW', { hour12: false })
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

function broadcastOnlineCount() {
  const fluctuation = Math.floor(Math.random() * 44) - 12;
  simulatedOnlineCount = Math.max(10, Math.min(9999, simulatedOnlineCount + fluctuation));
  const payload = JSON.stringify({
    type: 'online_count',
    onlineCount: simulatedOnlineCount + wss.clients.size
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// 輔助函式：廣播待審核清單給管理員
function broadcastPendingTopups() {
  const payload = JSON.stringify({
    type: 'update_pending_topups',
    list: pendingTopups
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.user && client.user.is_admin) {
      client.send(payload);
    }
  });
}

setInterval(broadcastOnlineCount, 7000);

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

function scheduleIdleReward(client) {
  const randomDelay = Math.floor(Math.random() * (300000 - 60000 + 1)) + 60000;

  client.idleTimer = setTimeout(async () => {
    if (client.readyState === WebSocket.OPEN && client.user && client.isIdle) {
      const isHp = Math.random() > 0.5;
      const potionName = isHp ? 'HP 藥水 x1' : 'MP 藥水 x1';
      const goldEarned = client.user.isGM ? 0 : (Math.floor(Math.random() * 5) + 1);
      const expEarned = Math.floor(Math.random() * 30) + 20;

      try {
        const userRes = await pool.query('SELECT level, exp, hp_potion, mp_potion, exp_scroll, gold, rank_points, stat_points FROM users WHERE id = $1', [client.user.id]);
        let userRow = userRes.rows[0];

        let currentLevel = userRow.level || 1;
        let currentExp = (userRow.exp || 0) + expEarned;
        let statPoints = userRow.stat_points || 0;
        let nextExpReq = getNextExpReq(currentLevel);
        let leveledUp = false;

        while (currentExp >= nextExpReq) {
          currentExp -= nextExpReq;
          currentLevel += 1;
          statPoints += 5;
          leveledUp = true;
          nextExpReq = getNextExpReq(currentLevel);
        }

        const updateQuery = isHp
          ? `UPDATE users SET hp_potion = hp_potion + 1, gold = gold + $1, exp = $2, level = $3, stat_points = $4 WHERE id = $5 RETURNING hp_potion, mp_potion, exp_scroll, gold, rank_points, level, exp, stat_points`
          : `UPDATE users SET mp_potion = mp_potion + 1, gold = gold + $1, exp = $2, level = $3, stat_points = $4 WHERE id = $5 RETURNING hp_potion, mp_potion, exp_scroll, gold, rank_points, level, exp, stat_points`;

        const updateRes = await pool.query(updateQuery, [goldEarned, currentExp, currentLevel, statPoints, client.user.id]);

        const inv = updateRes.rows[0];
        client.user.inventory = {
          hpPotion: inv.hp_potion,
          mpPotion: inv.mp_potion,
          expScroll: inv.exp_scroll,
          gold: client.user.isGM ? 999999 : inv.gold
        };
        client.user.level = inv.level;
        client.user.exp = inv.exp;
        client.user.stats.statPoints = inv.stat_points;

        let msg = `🧘 修練中... 獲得了 🧪 ${potionName}、💰 金幣 x${goldEarned}、✨ ${expEarned} 經驗值！`;
        if (leveledUp) {
          msg += ` 🎉 恭喜升級！當前等級提升至 LV.${currentLevel}，獲得了 5 點屬性點！`;
        }

        client.send(JSON.stringify({
          type: 'idle_reward',
          message: msg,
          inventory: client.user.inventory,
          level: client.user.level,
          exp: client.user.exp,
          stats: client.user.stats
        }));
      } catch (err) {
        console.error("掛機獎勵更新失敗:", err);
      }
    }

    if (client.readyState === WebSocket.OPEN && client.isIdle) {
      scheduleIdleReward(client);
    }
  }, randomDelay);
}

function createMatchWithAI(p1) {
  const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
  const aiName = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)];
  const aiRole = ALL_ROLES[Math.floor(Math.random() * ALL_ROLES.length)];
  
  const stats1 = p1.user ? p1.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };
  const maxHp1 = getCalculatedMaxHp(p1.role, stats1.vit);
  const baseMp1 = (ROLE_STATS[p1.role] || ROLE_STATS.berserker).mp;

  const aiVit = Math.floor(Math.random() * 15) + 10;
  const aiMaxHp = getCalculatedMaxHp(aiRole, aiVit);
  const aiBaseMp = (ROLE_STATS[aiRole] || ROLE_STATS.berserker).mp;
  const aiPlayerId = 'PLAYER_' + Math.random().toString(36).substr(2, 9);

  rooms[roomId] = {
    id: roomId,
    status: 'waiting',
    isAiMatch: true,
    regenTimer: null,
    aiTimer: null,
    players: [
      {
        id: p1.id, ws: p1.ws, name: p1.name, role: p1.role, team: 'A',
        hp: maxHp1, maxHp: maxHp1, mp: baseMp1, maxMp: baseMp1,
        level: p1.user ? p1.user.level : 1, stats: stats1,
        rankPoints: p1.rankPoints, statusEffects: {}, cooldowns: {}, isAi: false,
        inventory: p1.user ? p1.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 }
      },
      {
        id: aiPlayerId, ws: null, name: aiName, role: aiRole, team: 'B',
        hp: aiMaxHp, maxHp: aiMaxHp, mp: aiBaseMp, maxMp: aiBaseMp,
        level: Math.max(1, (p1.user ? p1.user.level : 1) + Math.floor(Math.random() * 2)),
        stats: { 
          statPoints: 0, 
          str: Math.floor(Math.random() * 15) + 10, 
          int: Math.floor(Math.random() * 15) + 10, 
          vit: aiVit, 
          agi: Math.floor(Math.random() * 15) + 10 
        },
        rankPoints: p1.rankPoints + (Math.floor(Math.random() * 60) - 30), 
        statusEffects: {}, cooldowns: {}, isAi: true,
        inventory: { hpPotion: 8, mpPotion: 8, expScroll: 1, gold: 0 }
      }
    ]
  };

  p1.ws.roomId = roomId;
  p1.ws.send(JSON.stringify({ type: 'match_found', roomId, player: rooms[roomId].players[0] }));
  broadcastRoomState(roomId);
}

// 🤖 5V5 專用 AI 戰鬥迴圈
function start5v5AIBattleLoop(roomId) {
  const room = rooms[roomId];
  if (!room || !room.isAiMatch) return;

  room.aiTimer = setInterval(() => {
    if (!rooms[roomId] || room.status !== 'playing') {
      clearInterval(room.aiTimer);
      return;
    }

    const activeAis = room.players.filter(p => p.isAi && p.hp > 0);
    if (activeAis.length === 0) return;
    const ai = activeAis[Math.floor(Math.random() * activeAis.length)];

    ai.mp = Math.min(ai.maxMp, ai.mp + 120);

    const enemies = room.players.filter(p => p.team !== ai.team && p.hp > 0);
    if (enemies.length === 0) return;
    const target = enemies[Math.floor(Math.random() * enemies.length)];

    if (ai.hp < ai.maxHp * 0.4 && ai.inventory.hpPotion > 0 && Math.random() < 0.8) {
      ai.inventory.hpPotion--;
      ai.hp = Math.min(ai.maxHp, ai.hp + 3500);
      broadcastBattleLog(roomId, `🧪 ${ai.name} 使用了 HP 藥水！`);
      broadcastRoomState(roomId);
      return;
    }

    if (ai.statusEffects && ai.statusEffects.blind && Math.random() < 0.5) {
      broadcastBattleLog(roomId, `👁️ ${ai.name} 受致盲影響，攻擊 MISS！`);
      broadcastRoomState(roomId);
      return;
    }

    const aiStr = (ai.stats && ai.stats.str) || 0;
    const useSkill = Math.random() < 0.6;

    if (useSkill && ai.mp >= 200) {
      ai.mp -= 200;
      let skillDmg = applyDefenseReduction(600 + (aiStr * 15), target.stats ? target.stats.vit : 0);
      target.hp = Math.max(0, target.hp - skillDmg);
      broadcastBattleLog(roomId, `⚔️ ${ai.name} 施展強力技能，對 ${target.name} 造成 ${skillDmg} 點傷害！`);
    } else {
      let baseDmg = Math.floor(Math.random() * 200) + 300 + (aiStr * 12);
      let isCrit = Math.random() < 0.15;
      if (isCrit) baseDmg = Math.floor(baseDmg * 1.5);

      const finalDmg = applyDefenseReduction(baseDmg, target.stats ? target.stats.vit : 0);
      target.hp = Math.max(0, target.hp - finalDmg);

      if (isCrit) {
        broadcastBattleLog(roomId, `💥⚡ ${ai.name} 觸發暴擊！對 ${target.name} 造成 ${finalDmg} 傷害！`);
      } else {
        broadcastBattleLog(roomId, `💥 ${ai.name} 對 ${target.name} 發動攻擊，造成 ${finalDmg} 傷害！`);
      }
    }

    const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
    const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

    if (!teamAAlive || !teamBAlive) {
      room.status = 'game_over';
      if (room.regenTimer) clearInterval(room.regenTimer);
      if (room.aiTimer) clearInterval(room.aiTimer);

      const winTeam = teamAAlive ? 'A' : 'B';
      const winTeamName = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';
      broadcastBattleLog(roomId, `🏆 遊戲結束！【${winTeamName}】獲得了最終勝利！`);

      room.players.forEach(async (p) => {
        if (!p.isAi) {
          const isWinner = (p.team === winTeam);
          const delta = isWinner ? 30 : -20;
          p.rankPoints = Math.max(0, (p.rankPoints || 0) + delta);
          if (p.ws && p.ws.user) {
            p.ws.user.rankPoints = p.rankPoints;
            try {
              await pool.query('UPDATE users SET rank_points = $1 WHERE id = $2', [p.rankPoints, p.ws.user.id]);
            } catch (e) {
              console.error("更新段位積分失敗:", e);
            }
          }
        }
      });
    }

    broadcastRoomState(roomId);
  }, 1500);
}

function addRandomAIPlayer(roomPlayers, team) {
  const aiName = AI_NAMES[Math.floor(Math.random() * AI_NAMES.length)] + '_' + Math.floor(Math.random() * 90 + 10);
  const aiRole = ALL_ROLES[Math.floor(Math.random() * ALL_ROLES.length)];
  const aiVit = Math.floor(Math.random() * 15) + 10;
  const aiMaxHp = getCalculatedMaxHp(aiRole, aiVit);
  const aiBaseMp = (ROLE_STATS[aiRole] || ROLE_STATS.berserker).mp;

  roomPlayers.push({
    id: 'AI_' + Math.random().toString(36).substr(2, 9),
    ws: null,
    name: aiName,
    role: aiRole,
    team: team,
    hp: aiMaxHp,
    maxHp: aiMaxHp,
    mp: aiBaseMp,
    maxMp: aiBaseMp,
    level: Math.floor(Math.random() * 5) + 10,
    stats: { statPoints: 0, str: 15, int: 15, vit: aiVit, agi: 15 },
    rankPoints: 1200,
    statusEffects: {},
    cooldowns: {},
    isAi: true,
    inventory: { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 }
  });
}

function create5v5Room(realPlayers, isAiMatch) {
  const roomId = 'ROOM_5V5_' + Math.floor(1000 + Math.random() * 9000);
  let roomPlayers = [];

  realPlayers.forEach((p, idx) => {
    const team = idx < 5 ? 'A' : 'B';
    const stats = p.user ? p.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };
    const maxHp = getCalculatedMaxHp(p.role, stats.vit);
    const baseMp = (ROLE_STATS[p.role] || ROLE_STATS.berserker).mp;

    roomPlayers.push({
      id: p.id, ws: p.ws, name: p.name, role: p.role, team,
      hp: maxHp, maxHp, mp: baseMp, maxMp: baseMp,
      level: p.user ? p.user.level : 1, stats, rankPoints: p.rankPoints,
      statusEffects: {}, cooldowns: {}, isAi: false,
      inventory: p.user ? p.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 }
    });
  });

  if (isAiMatch) {
    const teamACount = roomPlayers.filter(p => p.team === 'A').length;
    const teamBCount = roomPlayers.filter(p => p.team === 'B').length;

    for (let i = teamACount; i < 5; i++) {
      addRandomAIPlayer(roomPlayers, 'A');
    }
    for (let i = teamBCount; i < 5; i++) {
      addRandomAIPlayer(roomPlayers, 'B');
    }
  }

  rooms[roomId] = {
    id: roomId,
    status: 'playing',
    isAiMatch: true,
    regenTimer: null,
    aiTimer: null,
    players: roomPlayers
  };

  roomPlayers.forEach(p => {
    if (!p.isAi && p.ws) {
      p.ws.roomId = roomId;
      p.ws.send(JSON.stringify({ type: 'match_found', roomId, player: p }));
    }
  });

  rooms[roomId].regenTimer = setInterval(() => {
    if (!rooms[roomId] || rooms[roomId].status !== 'playing') {
      clearInterval(rooms[roomId].regenTimer);
      return;
    }
    rooms[roomId].players.forEach(p => {
      if (p.hp > 0 && p.mp < p.maxMp) p.mp = Math.min(p.maxMp, p.mp + 40);
    });
    broadcastRoomState(roomId);
  }, 1000);

  start5v5AIBattleLoop(roomId);
  broadcastRoomState(roomId);
  broadcastBattleLog(roomId, "⚔️【5V5 團戰爆發！】雙方十人陣容已就位，戰鬥正式開打！");
}

function startAIBattleLoop(roomId) {
  const room = rooms[roomId];
  if (!room || !room.isAiMatch) return;

  room.aiTimer = setInterval(() => {
    if (!rooms[roomId] || room.status !== 'playing') {
      clearInterval(room.aiTimer);
      return;
    }

    const ai = room.players.find(p => p.isAi && p.hp > 0);
    if (!ai) return;

    ai.mp = Math.min(ai.maxMp, ai.mp + 120);

    const enemies = room.players.filter(p => p.team !== ai.team && p.hp > 0);
    if (enemies.length === 0) return;
    const target = enemies[Math.floor(Math.random() * enemies.length)];

    if (ai.hp < ai.maxHp * 0.45 && ai.inventory.hpPotion > 0 && Math.random() < 0.75) {
      ai.inventory.hpPotion--;
      let healAmount = 3500;
      if (ai.statusEffects && ai.statusEffects.poison) {
        healAmount = Math.floor(healAmount * 0.5);
      }
      ai.hp = Math.min(ai.maxHp, ai.hp + healAmount);
      broadcastBattleLog(roomId, `🧪 ${ai.name} 使用了 HP 藥水！`);
      broadcastRoomState(roomId);
      return;
    }

    if (ai.statusEffects && ai.statusEffects.blind && Math.random() < 0.5) {
      broadcastBattleLog(roomId, `👁️ ${ai.name} 受致盲影響，攻擊 MISS！`);
      broadcastRoomState(roomId);
      return;
    }

    const aiStr = (ai.stats && ai.stats.str) || 0;
    const aiInt = (ai.stats && ai.stats.int) || 0;
    const useSkill = Math.random() < 0.65;

    if (useSkill && ai.mp >= 200) {
      ai.mp -= 200;

      if (ai.role === 'assassin' && Math.random() < 0.2) {
        const hpCost = Math.floor(ai.hp * 0.5);
        ai.hp = Math.max(1, ai.hp - hpCost);
        if (Math.random() < 0.15) {
          target.hp = 0;
          broadcastBattleLog(roomId, `☠️【秒殺觸發！】${ai.name} 消耗自身 ${hpCost} HP 發動【影之刺殺】，成功秒殺了 ${target.name}！`);
        } else {
          let dmg = applyDefenseReduction(800 + (aiStr * 15), target.stats ? target.stats.vit : 0);
          target.hp = Math.max(0, target.hp - dmg);
          broadcastBattleLog(roomId, `🗡️⚡ ${ai.name} 發動【影之刺殺】，對 ${target.name} 造成 ${dmg} 傷害！`);
        }
      } else if (ai.role === 'archer') {
        let totalDmg = 0;
        for (let i = 0; i < 10; i++) {
          totalDmg += Math.floor(target.maxHp * 0.012) + Math.floor(aiStr * 1.5);
        }
        totalDmg = applyDefenseReduction(totalDmg, target.stats ? target.stats.vit : 0);
        target.hp = Math.max(0, target.hp - totalDmg);
        broadcastBattleLog(roomId, `🏹 ${ai.name} 施展【暴風箭雨】10連擊！對 ${target.name} 造成 ${totalDmg} 點傷害！`);
      } else if (ai.role === 'mage' || ai.role === 'priest') {
        let spellDmg = applyDefenseReduction(450 + (aiInt * 18), target.stats ? target.stats.vit : 0);
        target.hp = Math.max(0, target.hp - spellDmg);
        broadcastBattleLog(roomId, `🔥 ${ai.name} 吟唱高階法術！對 ${target.name} 造成 ${spellDmg} 點毀滅傷害！`);
      } else {
        let skillDmg = applyDefenseReduction(500 + (aiStr * 14), target.stats ? target.stats.vit : 0);
        target.hp = Math.max(0, target.hp - skillDmg);
        broadcastBattleLog(roomId, `⚔️ ${ai.name} 發動極限重擊！對 ${target.name} 造成 ${skillDmg} 點傷害！`);
      }
    } else {
      const targetAgi = (target.stats && target.stats.agi) || 0;
      if (Math.random() < (targetAgi * 0.008)) {
        broadcastBattleLog(roomId, `💨 ${target.name} 憑藉高超敏捷，成功閃避了 ${ai.name} 的普通攻擊！`);
        broadcastRoomState(roomId);
        return;
      }

      let baseDmg = Math.floor(Math.random() * 200) + 250 + (aiStr * 12);
      let isCrit = Math.random() < (ai.stats.agi * 0.015);
      if (isCrit) baseDmg = Math.floor(baseDmg * 1.6);

      const finalDmg = applyDefenseReduction(baseDmg, target.stats ? target.stats.vit : 0);
      target.hp = Math.max(0, target.hp - finalDmg);

      if (isCrit) {
        broadcastBattleLog(roomId, `💥⚡ ${ai.name} 觸發暴擊！對 ${target.name} 造成 ${finalDmg} 傷害！`);
      } else {
        broadcastBattleLog(roomId, `💥 ${ai.name} 對 ${target.name} 發動普通攻擊，造成 ${finalDmg} 傷害！`);
      }
    }

    const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
    const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

    if (!teamAAlive || !teamBAlive) {
      room.status = 'game_over';
      if (room.regenTimer) clearInterval(room.regenTimer);
      if (room.aiTimer) clearInterval(room.aiTimer);

      const winTeam = teamAAlive ? 'A' : 'B';
      const winTeamName = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';
      broadcastBattleLog(roomId, `🏆 遊戲結束！【${winTeamName}】獲得了最終勝利！`);

      room.players.forEach(async (p) => {
        if (!p.isAi) {
          const isWinner = (p.team === winTeam);
          const delta = isWinner ? 25 : -15;
          p.rankPoints = Math.max(0, (p.rankPoints || 0) + delta);
          const rInfo = getRankInfo(p.rankPoints);
          broadcastBattleLog(roomId, `🎖️ ${p.name} (${isWinner ? '獲勝' : '戰敗'})：積分 ${delta > 0 ? '+' + delta : delta} (總分: ${p.rankPoints} - ${rInfo.icon} ${rInfo.name})`);
          
          if (p.ws && p.ws.user) {
            p.ws.user.rankPoints = p.rankPoints;
            try {
              await pool.query('UPDATE users SET rank_points = $1 WHERE id = $2', [p.rankPoints, p.ws.user.id]);
            } catch (e) {
              console.error("更新段位積分失敗:", e);
            }
          }
        }
      });
    }

    broadcastRoomState(roomId);
  }, 1200);
}

wss.on('connection', (ws) => {
  ws.id = 'PLAYER_' + Math.random().toString(36).substr(2, 9);
  ws.isIdle = true;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.send(JSON.stringify({ type: 'online_count', onlineCount: simulatedOnlineCount + wss.clients.size }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      // 👑 管理員審核派送金幣邏輯 (已整合至 Postgres)
      if (data.type === 'admin_approve_topup') {
        if (!ws.user || !ws.user.is_admin) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 您沒有管理員權限！' }));
        }

        const { targetUserId, goldAmount } = data;
        const amount = parseInt(goldAmount);

        if (!targetUserId || isNaN(amount) || amount <= 0) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 請填寫正確的目標玩家帳號與正整數金幣數量！' }));
        }

        try {
          const targetRes = await pool.query('SELECT * FROM users WHERE username = $1', [targetUserId]);
          if (targetRes.rows.length === 0) {
            return ws.send(JSON.stringify({ type: 'error', message: `⚠️ 找不到目標玩家：${targetUserId}` }));
          }

          const targetUser = targetRes.rows[0];
          const newGold = (targetUser.gold || 0) + amount;

          await pool.query('UPDATE users SET gold = $1 WHERE username = $2', [newGold, targetUserId]);

          // 回報派送成功給管理員
          ws.send(JSON.stringify({
            type: 'admin_action_success',
            message: `✅ 成功派送 ${amount} 金幣給玩家 [${targetUserId}]！該玩家當前總金幣: ${newGold}`
          }));

          // 若目標線上，直接更新其畫面
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.user && client.user.name === targetUserId) {
              client.user.inventory.gold = newGold;
              client.send(JSON.stringify({
                type: 'gold_received',
                message: `🎉 管理員已核發您的儲值金幣，獲得 ${amount} 金幣！`,
                inventory: client.user.inventory
              }));
            }
          });

        } catch (err) {
          console.error("派送金幣失敗：", err);
          ws.send(JSON.stringify({ type: 'error', message: '🔴 派送金幣失敗，伺服器資料庫錯誤。' }));
        }
      }

      // 💳 儲值申請處理邏輯 (佇列化管理員審核系統)
      else if (data.type === 'submit_topup') {
        const playerName = (ws.user && ws.user.name) ? ws.user.name : (ws.user && ws.user.username) || '未知玩家';
        const amount = parseInt(data.amount) || 0;
        const paymentInfo = data.paymentInfo || '無備註';
        
        // 建立唯一的申請單 ID
        const requestId = 'TOPUP_' + Math.random().toString(36).substr(2, 9);
        
        const topupRequest = {
          requestId,
          userId: ws.user ? ws.user.id : null,
          username: ws.user ? ws.user.username : 'unknown',
          playerName,
          amount,
          paymentInfo,
          time: new Date().toLocaleTimeString('zh-TW', { hour12: false })
        };
        
        // 加入待審核清單
        pendingTopups.push(topupRequest);
        
        // 回覆玩家申請已送出
        ws.send(JSON.stringify({
          type: 'topup_response',
          success: true,
          message: '✅ 儲值申請已順利送出，管理員正在審核中！'
        }));
        
        // 🔴 自動廣播最新待審核清單給所有在線的管理員
        broadcastPendingTopups();
      }

      // 👑 管理員透過佇列審核並核准或拒絕特定儲值申請 (ADMIN_AUDIT_ACTION)
      else if (data.type === 'ADMIN_AUDIT_ACTION') {
        if (!ws.user || !ws.user.is_admin) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 您沒有管理員權限！' }));
        }
        
        const { targetUserId, action, requestId } = data; // action 可以是 'approve' 或 'reject'
        // 同時支援用 requestId 或 targetUserId 來尋找佇列項目
        const index = pendingTopups.findIndex(item => item.requestId === requestId || item.userId === targetUserId || item.username === targetUserId);
        
        if (index === -1) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 找不到該筆儲值申請，可能已被審核或失效。' }));
        }
        
        const reqItem = pendingTopups.splice(index, 1)[0]; // 從佇列中移除

        if (action === 'approve') {
          try {
            // 1. 從資料庫抓取玩家當前金幣
            const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [reqItem.userId]);
            if (targetRes.rows.length === 0) {
              return ws.send(JSON.stringify({ type: 'error', message: `⚠️ 找不到目標玩家 ID: ${reqItem.userId}` }));
            }
            
            const targetUser = targetRes.rows[0];
            const newGold = (targetUser.gold || 0) + reqItem.amount;
            
            // 2. 更新資料庫金幣
            await pool.query('UPDATE users SET gold = $1 WHERE id = $2', [newGold, reqItem.userId]);
            
            // 3. 通知管理員端更新介面
            ws.send(JSON.stringify({
              type: 'NOTIFICATION',
              message: `✅ 已成功核實玩家 [${reqItem.playerName}] 的 ${reqItem.amount} TWD 儲值！`
            }));
            
            // 4. 重新廣播更新後的待審核清單給所有管理員
            broadcastPendingTopups();
            
            // 5. 若該玩家在線上，直接派發金幣並跳出提示
            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.user && client.user.id === reqItem.userId) {
                client.user.inventory.gold = newGold;
                client.send(JSON.stringify({
                  type: 'gold_received',
                  message: `🎉 您的儲值申請已通過！成功獲得 ${reqItem.amount} 金幣！`,
                  inventory: client.user.inventory
                }));
              }
            });
            
          } catch (err) {
            console.error("審核儲值失敗：", err);
            ws.send(JSON.stringify({ type: 'error', message: '🔴 伺服器資料庫錯誤，審核失敗。' }));
          }
        } else if (action === 'reject') {
          try {
            broadcastPendingTopups();

            ws.send(JSON.stringify({
              type: 'NOTIFICATION',
              message: '已成功拒絕該筆申請'
            }));

            wss.clients.forEach(client => {
              if (client.readyState === WebSocket.OPEN && client.user && client.user.id === reqItem.userId) {
                client.send(JSON.stringify({
                  type: 'NOTIFICATION',
                  message: '⚠️ 您的儲值申請已被管理員拒絕。'
                }));
              }
            });
          } catch (err) {
            console.error("拒絕儲值失敗：", err);
            ws.send(JSON.stringify({ type: 'error', message: '🔴 伺服器資料庫錯誤，拒絕操作失敗。' }));
          }
        }
      }

      // 相容舊版的單一核准呼叫
      else if (data.type === 'admin_approve_topup_request') {
        if (!ws.user || !ws.user.is_admin) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 您沒有管理員權限！' }));
        }
        
        const { requestId } = data;
        const index = pendingTopups.findIndex(item => item.requestId === requestId);
        
        if (index === -1) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 找不到該筆儲值申請，可能已被審核或失效。' }));
        }
        
        const reqItem = pendingTopups.splice(index, 1)[0];
        
        try {
          const targetRes = await pool.query('SELECT * FROM users WHERE id = $1', [reqItem.userId]);
          if (targetRes.rows.length === 0) {
            return ws.send(JSON.stringify({ type: 'error', message: `⚠️ 找不到目標玩家 ID: ${reqItem.userId}` }));
          }
          
          const targetUser = targetRes.rows[0];
          const newGold = (targetUser.gold || 0) + reqItem.amount;
          
          await pool.query('UPDATE users SET gold = $1 WHERE id = $2', [newGold, reqItem.userId]);
          
          ws.send(JSON.stringify({
            type: 'admin_action_success',
            message: `✅ 已成功核實玩家 [${reqItem.playerName}] 的 ${reqItem.amount} TWD 儲值！`
          }));
          
          broadcastPendingTopups();
          
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.user && client.user.id === reqItem.userId) {
              client.user.inventory.gold = newGold;
              client.send(JSON.stringify({
                type: 'gold_received',
                message: `🎉 您的儲值申請已通過！成功獲得 ${reqItem.amount} 金幣！`,
                inventory: client.user.inventory
              }));
            }
          });
        } catch (err) {
          console.error("審核儲值失敗：", err);
          ws.send(JSON.stringify({ type: 'error', message: '🔴 伺服器資料庫錯誤，審核失敗。' }));
        }
      }

      // 2. 註冊邏輯 (PostgreSQL 版)
      else if (data.type === 'register') {
        const { username, password } = data;
        if (!username || !password) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號與密碼不能為空！' }));
        
        const hashedPassword = await bcrypt.hash(password, 10);
        const isAdminFlag = (username === '空白') ? true : false;

        try {
          await pool.query(
            `INSERT INTO users (username, password_hash, name, role, level, exp, gold, hp_potion, mp_potion, exp_scroll, is_admin) 
             VALUES ($1, $2, $3, 'berserker', 1, 0, 100, 5, 5, 1, $4)`,
            [username, hashedPassword, username, isAdminFlag]
          );
          ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功！請直接登入。' }));
        } catch (e) {
          ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該帳號已被註冊！' }));
        }
      }

      // 1. 登入邏輯 (PostgreSQL 版)
      else if (data.type === 'login') {
        const { username, password } = data;
        const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (res.rows.length === 0) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));
        
        const row = res.rows[0];
        const valid = await bcrypt.compare(password, row.password_hash);
        if (!valid) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 帳號或密碼錯誤！' }));

        let isAdmin = row.is_admin;
        if (username === '空白') {
          await pool.query(`UPDATE users SET is_admin = TRUE WHERE username = '空白'`);
          isAdmin = true;
        }

        const isGM = isAdmin || ((username === '空白' || username.trim() === '') && password === '0976161683');
        const initialStatPoints = isGM ? 9999 : (row.stat_points || 0);
        const initialGold = isGM ? 999999 : (row.gold || 0);

        ws.user = {
          id: row.id,
          username: row.username,
          name: row.name || username,
          role: row.role || 'berserker',
          level: row.level || 1,
          exp: row.exp || 0,
          rankPoints: row.rank_points || 0,
          rankInfo: getRankInfo(row.rank_points || 0),
          is_admin: Boolean(isAdmin),
          isGM: isGM,
          stats: {
            statPoints: initialStatPoints,
            str: row.str || 0,
            int: row.int_stat || 0,
            vit: row.vit || 0,
            agi: row.agi || 0
          },
          inventory: {
            gold: initialGold,
            hpPotion: row.hp_potion || 0,
            mpPotion: row.mp_potion || 0,
            expScroll: row.exp_scroll || 0
          }
        };

        ws.playerName = username;
        ws.isIdle = true;

        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        scheduleIdleReward(ws);

        ws.send(JSON.stringify({
          type: 'login_success',
          user: {
            name: ws.user.name,
            role: ws.user.role,
            level: ws.user.level,
            exp: ws.user.exp,
            inventory: ws.user.inventory,
            stats: ws.user.stats
          },
          isAdmin: Boolean(ws.user.is_admin)
        }));

        if (ws.user.is_admin) {
          ws.send(JSON.stringify({
            type: 'update_pending_topups',
            list: pendingTopups
          }));
        }
      }

      else if (data.type === 'update_stats') {
        if (!ws.user || !data.stats) return;
        const { statPoints, str, int, vit, agi } = data.stats;

        try {
          if (!ws.user.isGM) {
            const dbRes = await pool.query('SELECT stat_points, str, int_stat, vit, agi FROM users WHERE id = $1', [ws.user.id]);
            const dbUser = dbRes.rows[0];
            const totalPointsBefore = dbUser.stat_points + dbUser.str + dbUser.int_stat + dbUser.vit + dbUser.agi;
            const totalPointsAfter = statPoints + str + int + vit + agi;

            if (totalPointsBefore !== totalPointsAfter) {
              return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 點數計算異常！' }));
            }
          }

          await pool.query(
            `UPDATE users 
             SET stat_points = $1, str = $2, int_stat = $3, vit = $4, agi = $5 
             WHERE id = $6`,
            [statPoints, str, int, vit, agi, ws.user.id]
          );

          ws.user.stats = { statPoints, str, int, vit, agi };

          if (ws.roomId && rooms[ws.roomId]) {
            const p = rooms[ws.roomId].players.find(pl => pl.id === ws.id);
            if (p) {
              p.stats = ws.user.stats;
              p.maxHp = getCalculatedMaxHp(p.role, p.stats.vit);
              p.hp = Math.min(p.hp, p.maxHp);
              broadcastRoomState(ws.roomId);
            }
          }

          ws.send(JSON.stringify({
            type: 'stats_updated',
            message: ws.user.isGM ? '👑 [GM 特權] 屬性點數自由分配成功！' : '✨ 屬性點數配點成功！',
            stats: ws.user.stats
          }));
        } catch (err) {
          console.error("更新屬性點失敗:", err);
        }
      }

      else if (data.type === 'reset_stats') {
        if (!ws.user) return;
        try {
          let totalRefunded = 0;

          if (ws.user.isGM) {
            totalRefunded = 9999;
          } else {
            const dbRes = await pool.query('SELECT str, int_stat, vit, agi, stat_points FROM users WHERE id = $1', [ws.user.id]);
            const current = dbRes.rows[0];
            totalRefunded = (current.str || 0) + (current.int_stat || 0) + (current.vit || 0) + (current.agi || 0) + (current.stat_points || 0);
          }

          await pool.query(
            `UPDATE users SET str = 0, int_stat = 0, vit = 0, agi = 0, stat_points = $1 WHERE id = $2`,
            [totalRefunded, ws.user.id]
          );

          ws.user.stats = { statPoints: totalRefunded, str: 0, int: 0, vit: 0, agi: 0 };

          if (ws.roomId && rooms[ws.roomId]) {
            const p = rooms[ws.roomId].players.find(pl => pl.id === ws.id);
            if (p) {
              p.stats = ws.user.stats;
              p.maxHp = getCalculatedMaxHp(p.role, 0);
              p.hp = Math.min(p.hp, p.maxHp);
              broadcastRoomState(ws.roomId);
            }
          }

          ws.send(JSON.stringify({
            type: 'stats_updated',
            message: '🔄 屬性點數已重置！',
            stats: ws.user.stats
          }));
        } catch (err) {
          console.error("重置屬性點數失敗:", err);
        }
      }

      else if (data.type === 'buy_item') {
        const { itemType } = data;
        const validItems = {
          hp_potion: { col: 'hp_potion', cost: 10 },
          mp_potion: { col: 'mp_potion', cost: 10 },
          exp_scroll: { col: 'exp_scroll', cost: 50 }
        };

        const itemInfo = validItems[itemType];
        if (!itemInfo || !ws.user) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 無法購買該商品！' }));

        try {
          if (ws.user.isGM) {
            const updateQuery = itemType === 'hp_potion'
              ? `UPDATE users SET hp_potion = hp_potion + 1 WHERE id = $1 RETURNING hp_potion, mp_potion, exp_scroll`
              : itemType === 'mp_potion'
              ? `UPDATE users SET mp_potion = mp_potion + 1 WHERE id = $1 RETURNING hp_potion, mp_potion, exp_scroll`
              : `UPDATE users SET exp_scroll = exp_scroll + 1 WHERE id = $1 RETURNING hp_potion, mp_potion, exp_scroll`;

            const updateRes = await pool.query(updateQuery, [ws.user.id]);
            const updated = updateRes.rows[0];

            ws.user.inventory = {
              hpPotion: updated.hp_potion,
              mpPotion: updated.mp_potion,
              expScroll: updated.exp_scroll,
              gold: 999999
            };

            return ws.send(JSON.stringify({
              type: 'shop_success',
              message: '👑 [GM 特權] 購買成功！金幣無限且不扣除。',
              inventory: ws.user.inventory
            }));
          }

          const userRes = await pool.query('SELECT gold FROM users WHERE id = $1', [ws.user.id]);
          const dbUser = userRes.rows[0];

          if (dbUser.gold < itemInfo.cost) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 金幣不足！' }));

          const updateQuery = itemType === 'hp_potion'
            ? `UPDATE users SET gold = gold - $1, hp_potion = hp_potion + 1 WHERE id = $2 RETURNING gold, hp_potion, mp_potion, exp_scroll`
            : itemType === 'mp_potion'
            ? `UPDATE users SET gold = gold - $1, mp_potion = mp_potion + 1 WHERE id = $2 RETURNING gold, hp_potion, mp_potion, exp_scroll`
            : `UPDATE users SET gold = gold - $1, exp_scroll = exp_scroll + 1 WHERE id = $2 RETURNING gold, hp_potion, mp_potion, exp_scroll`;

          const updateRes = await pool.query(updateQuery, [itemInfo.cost, ws.user.id]);
          const updated = updateRes.rows[0];

          ws.user.inventory = {
            hpPotion: updated.hp_potion,
            mpPotion: updated.mp_potion,
            expScroll: updated.exp_scroll,
            gold: updated.gold
          };

          ws.send(JSON.stringify({
            type: 'shop_success',
            message: `🛒 購買成功！消耗 ${itemInfo.cost} 金幣。`,
            inventory: ws.user.inventory
          }));
        } catch (err) {
          console.error("購買失敗:", err);
        }
      }

      else if (data.type === 'use_exp_scroll') {
        if (!ws.user) return;
        try {
          const res = await pool.query('SELECT exp_scroll, exp, level, stat_points FROM users WHERE id = $1', [ws.user.id]);
          let { exp_scroll: scrollCount, exp: currentExp, level: currentLevel, stat_points: statPoints } = res.rows[0];

          if (scrollCount <= 0) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 卷軸數量不足！' }));

          currentExp += 150;
          scrollCount -= 1;
          let nextReq = getNextExpReq(currentLevel);
          let leveledUp = false;

          while (currentExp >= nextReq) {
            currentExp -= nextReq;
            currentLevel += 1;
            statPoints = (statPoints || 0) + 5;
            leveledUp = true;
            nextReq = getNextExpReq(currentLevel);
          }

          const updateRes = await pool.query(
            'UPDATE users SET exp = $1, level = $2, exp_scroll = $3, stat_points = $4 WHERE id = $5 RETURNING hp_potion, mp_potion, exp_scroll, gold',
            [currentExp, currentLevel, scrollCount, statPoints, ws.user.id]
          );

          ws.user.level = currentLevel;
          ws.user.exp = currentExp;
          ws.user.stats.statPoints = statPoints;

          const inv = updateRes.rows[0];
          ws.user.inventory = { 
            hpPotion: inv.hp_potion, 
            mpPotion: inv.mp_potion, 
            expScroll: inv.exp_scroll, 
            gold: ws.user.isGM ? 999999 : inv.gold 
          };

          let msg = `📜 使用經驗卷軸成功！獲得 +150 EXP。`;
          if (leveledUp) {
            msg += ` 🎉 恭喜升級！等級提升至 LV.${currentLevel}，獲得了 5 點屬性點！`;
          }

          ws.send(JSON.stringify({
            type: 'idle_reward',
            message: msg,
            inventory: ws.user.inventory,
            level: ws.user.level,
            exp: ws.user.exp,
            stats: ws.user.stats
          }));
        } catch (e) {
          console.error("使用經驗卷軸失敗:", e);
        }
      }

      else if (data.type === 'send_lobby_chat') {
        const senderName = (ws.user && ws.user.name) ? ws.user.name : (data.name || '玩家');
        if (data.message && data.message.trim() !== '') {
          broadcastLobbyChat(senderName, data.message.trim());
        }
      }

      // 👥 加入 5V5 團戰隨機匹配
      else if (data.type === 'join_queue_5v5') {
        matchQueue5v5 = matchQueue5v5.filter(p => p.ws.readyState === WebSocket.OPEN && p.ws !== ws);
        const role = data.role || (ws.user ? ws.user.role : 'berserker');
        const name = data.name || (ws.user ? ws.user.name : '勇者');
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        const queuePlayer = { ws, id: ws.id, name, role, rankPoints: rankPts, user: ws.user };
        matchQueue5v5.push(queuePlayer);
        ws.isIdle = false;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);

        ws.send(JSON.stringify({ type: 'queue_joined', message: '🔍 正在尋找 5V5 團戰對手...' }));

        if (matchQueue5v5.length >= 10) {
          const roomPlayers = matchQueue5v5.splice(0, 10);
          create5v5Room(roomPlayers, false);
        } else {
          setTimeout(() => {
            const index = matchQueue5v5.findIndex(p => p.ws === ws);
            if (index !== -1) {
              matchQueue5v5.splice(index, 1);
              create5v5Room([queuePlayer], true);
            }
          }, 4000);
        }
      }

      else if (data.type === 'leave_queue_5v5') {
        matchQueue5v5 = matchQueue5v5.filter(p => p.ws !== ws);
        ws.isIdle = true;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        scheduleIdleReward(ws);
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      else if (data.type === 'join_queue') {
        matchQueue = matchQueue.filter(p => p.ws.readyState === WebSocket.OPEN && p.ws !== ws);
        const role = data.role || (ws.user ? ws.user.role : 'berserker');
        const name = data.name || (ws.user ? ws.user.name : '勇者');
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        const queuePlayer = { ws, id: ws.id, name, role, rankPoints: rankPts, user: ws.user };
        matchQueue.push(queuePlayer);
        ws.isIdle = false;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);

        ws.send(JSON.stringify({ type: 'queue_joined' }));

        if (matchQueue.length >= 2) {
          const p1 = matchQueue.shift();
          const p2 = matchQueue.shift();
          const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
          
          const u1Stats = p1.user ? p1.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };
          const u2Stats = p2.user ? p2.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };

          const maxHp1 = getCalculatedMaxHp(p1.role, u1Stats.vit);
          const maxHp2 = getCalculatedMaxHp(p2.role, u2Stats.vit);

          const baseMp1 = (ROLE_STATS[p1.role] || ROLE_STATS.berserker).mp;
          const baseMp2 = (ROLE_STATS[p2.role] || ROLE_STATS.berserker).mp;

          rooms[roomId] = {
            id: roomId, status: 'waiting', isAiMatch: false, regenTimer: null,
            players: [
              { id: p1.id, ws: p1.ws, name: p1.name, role: p1.role, team: 'A', hp: maxHp1, maxHp: maxHp1, mp: baseMp1, maxMp: baseMp1, level: p1.user ? p1.user.level : 1, stats: u1Stats, rankPoints: p1.rankPoints, statusEffects: {}, cooldowns: {}, isAi: false, inventory: p1.user ? p1.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 } },
              { id: p2.id, ws: p2.ws, name: p2.name, role: p2.role, team: 'B', hp: maxHp2, maxHp: maxHp2, mp: baseMp2, maxMp: baseMp2, level: p2.user ? p2.user.level : 1, stats: u2Stats, rankPoints: p2.rankPoints, statusEffects: {}, cooldowns: {}, isAi: false, inventory: p2.user ? p2.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 } }
            ]
          };

          p1.ws.roomId = roomId; p2.ws.roomId = roomId;
          p1.ws.send(JSON.stringify({ type: 'match_found', roomId, player: rooms[roomId].players[0] }));
          p2.ws.send(JSON.stringify({ type: 'match_found', roomId, player: rooms[roomId].players[1] }));
          broadcastRoomState(roomId);
        } else {
          setTimeout(() => {
            const index = matchQueue.findIndex(p => p.ws === ws);
            if (index !== -1) {
              matchQueue.splice(index, 1);
              createMatchWithAI(queuePlayer);
            }
          }, 3000);
        }
      }

      else if (data.type === 'leave_queue') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        ws.isIdle = true;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        scheduleIdleReward(ws);
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      else if (data.type === 'create_room') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        const roomId = 'ROOM_' + Math.floor(1000 + Math.random() * 9000);
        const role = data.role || 'berserker';
        const name = data.name || '勇者';
        const team = data.team || 'A';
        const userStats = ws.user ? ws.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };
        const maxHp = getCalculatedMaxHp(role, userStats.vit);
        const baseMp = (ROLE_STATS[role] || ROLE_STATS.berserker).mp;
        const rankPts = ws.user ? ws.user.rankPoints : 0;

        rooms[roomId] = {
          id: roomId, status: 'waiting', isAiMatch: false, regenTimer: null,
          players: [{ id: ws.id, ws, name, role, team, hp: maxHp, maxHp: maxHp, mp: baseMp, maxMp: baseMp, level: ws.user ? ws.user.level : 1, stats: userStats, rankPoints: rankPts, statusEffects: {}, cooldowns: {}, isAi: false, inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 } }]
        };

        ws.roomId = roomId; ws.isIdle = false;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        ws.send(JSON.stringify({ type: 'room_created', roomId, player: rooms[roomId].players[0] }));
        broadcastRoomState(roomId);
      }

      else if (data.type === 'join_room') {
        matchQueue = matchQueue.filter(p => p.ws !== ws);
        const { roomId, role, name, targetTeam } = data;
        const room = rooms[roomId];

        if (!room) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 找不到該房間！' }));
        if (room.players.length >= 10) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 房間已滿！' }));

        let assignedTeam = targetTeam || 'A';
        if (room.players.filter(p => p.team === assignedTeam).length >= 5) {
          assignedTeam = assignedTeam === 'A' ? 'B' : 'A';
        }

        const userStats = ws.user ? ws.user.stats : { str: 0, int: 0, vit: 0, agi: 0 };
        const maxHp = getCalculatedMaxHp(role, userStats.vit);
        const baseMp = (ROLE_STATS[role] || ROLE_STATS.berserker).mp;

        const newPlayer = {
          id: ws.id, ws, name: name || '勇者', role, team: assignedTeam, hp: maxHp, maxHp: maxHp, mp: baseMp, maxMp: baseMp, level: ws.user ? ws.user.level : 1, stats: userStats, rankPoints: ws.user ? ws.user.rankPoints : 0, statusEffects: {}, cooldowns: {}, isAi: false, inventory: ws.user ? ws.user.inventory : { hpPotion: 5, mpPotion: 5, expScroll: 1, gold: 0 }
        };

        room.players.push(newPlayer);
        ws.roomId = roomId; ws.isIdle = false;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        ws.send(JSON.stringify({ type: 'room_joined', roomId, player: newPlayer }));
        broadcastRoomState(roomId);
      }

      else if (data.type === 'switch_team') {
        const room = rooms[ws.roomId];
        if (!room || room.status !== 'waiting') return;
        const p = room.players.find(p => p.id === ws.id);
        if (!p) return;

        if (room.players.filter(pl => pl.team === data.targetTeam).length >= 5) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該隊伍人數已滿！' }));
        }

        p.team = data.targetTeam;
        broadcastBattleLog(room.id, `🔄 ${p.name} 切換到了 隊伍 ${data.targetTeam}！`);
        broadcastRoomState(room.id);
      }

      else if (data.type === 'start_game') {
        const room = rooms[ws.roomId];
        if (room && room.status === 'waiting') {
          room.status = 'playing';
          room.regenTimer = setInterval(() => {
            if (!rooms[room.id] || room.status !== 'playing') {
              clearInterval(room.regenTimer);
              return;
            }
            let updated = false;
            room.players.forEach(p => {
              if (p.hp > 0 && p.mp < p.maxMp) {
                p.mp = Math.min(p.maxMp, p.mp + 50);
                updated = true;
              }
            });
            if (updated) broadcastRoomState(room.id);
          }, 1000);

          if (room.isAiMatch) {
            if (room.players.length > 2) {
              start5v5AIBattleLoop(room.id);
            } else {
              startAIBattleLoop(room.id);
            }
          }
          broadcastRoomState(room.id);
          broadcastBattleLog(room.id, "⚔️ 戰鬥開始！每秒會自動回復 50 魔力 (MP)！");
        }
      }

      else if (data.type === 'use_skill') {
        const room = rooms[ws.roomId];
        if (!room || room.status !== 'playing') return;

        const caster = room.players.find(p => p.id === ws.id);
        if (!caster || caster.hp <= 0) return;

        const now = Date.now();
        caster.cooldowns = caster.cooldowns || {};

        if (caster.cooldowns[data.skillName] && caster.cooldowns[data.skillName] > now) {
          const remainingSec = Math.ceil((caster.cooldowns[data.skillName] - now) / 1000);
          return ws.send(JSON.stringify({ type: 'error', message: `⚠️ 技能【${data.skillName}】冷卻中，剩餘 ${remainingSec} 秒！` }));
        }

        if (caster.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ MP 不足！' }));
        }

        if (caster.statusEffects && caster.statusEffects.blind && Math.random() < 0.5) {
          caster.mp -= data.mpCost;
          broadcastBattleLog(room.id, `👁️ ${caster.name} 受致盲影響，技能 MISS！`);
          broadcastRoomState(room.id);
          return;
        }

        caster.mp -= data.mpCost;

        const casterStats = caster.stats || { str: 0, int: 0, vit: 0, agi: 0 };
        const strBonus = data.strAtkBonus || (casterStats.str * 12);
        const intBonus = data.intMagBonus || (casterStats.int * 15);
        const agiCritBonus = data.critChanceBonus || (casterStats.agi * 0.01);

        if (data.skillName === '🏹 暴風箭雨' || data.isArrowStormSkill) {
          caster.cooldowns['🏹 暴風箭雨'] = now + 30000;

          let target = room.players.find(p => p.id === data.targetId) || room.players.find(p => p.team !== caster.team && p.hp > 0);
          
          if (target && target.hp > 0) {
            let totalDmg = 0;
            let hits = 10;
            for (let i = 0; i < hits; i++) {
              let hitDmgPercent = (Math.random() * (2.0 - 0.5) + 0.5) / 100;
              let hitDmg = Math.floor(target.maxHp * hitDmgPercent) + Math.floor(strBonus / 10);
              totalDmg += hitDmg;
            }

            totalDmg = applyDefenseReduction(totalDmg, target.stats ? target.stats.vit : 0);
            target.hp = Math.max(0, target.hp - totalDmg);

            target.statusEffects = target.statusEffects || {};
            target.statusEffects.blind = true;

            broadcastBattleLog(room.id, `🏹 ${caster.name} 施展【暴風箭雨】10連擊！對 ${target.name} 造成 ${totalDmg} 點傷害，並致盲 3 秒！`);

            setTimeout(() => {
              if (target.statusEffects) {
                target.statusEffects.blind = false;
                if (rooms[room.id]) broadcastRoomState(room.id);
              }
            }, 3000);

            if (target.role === 'knight' && totalDmg > 0) {
              const reflectDmg = Math.floor(totalDmg * 0.05);
              caster.hp = Math.max(0, caster.hp - reflectDmg);
              broadcastBattleLog(room.id, `🏰 ${target.name} (騎士) 荊棘反傷，反彈 ${reflectDmg} 傷害！`);
            }
          }

          broadcastRoomState(room.id);
          return;
        }

        if (data.skillName === '🗡️ 影之刺殺' || data.isInstantKillSkill) {
          const hpCost = Math.floor(caster.hp * 0.5);
          caster.hp = Math.max(1, caster.hp - hpCost);

          let target = room.players.find(p => p.id === data.targetId) || room.players.find(p => p.team !== caster.team && p.hp > 0);
          
          if (target && target.hp > 0) {
            const isInstantKill = Math.random() < 0.10;

            if (isInstantKill) {
              target.hp = 0;
              broadcastBattleLog(room.id, `☠️【秒殺觸發！】${caster.name} 消耗自身 ${hpCost} HP 發動【影之刺殺】，成功秒殺了 ${target.name}！`);
            } else {
              let normalDmg = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal + strBonus;
              
              const isCrit = Math.random() < (0.15 + agiCritBonus);
              if (isCrit) normalDmg = Math.floor(normalDmg * 1.5);

              normalDmg = applyDefenseReduction(normalDmg, target.stats ? target.stats.vit : 0);

              if (isCrit) {
                broadcastBattleLog(room.id, `🗡️⚡ ${caster.name} 觸發暴擊！消耗 ${hpCost} HP 發動【影之刺殺】，對 ${target.name} 造成 ${normalDmg} 暴擊傷害！`);
              } else {
                broadcastBattleLog(room.id, `🗡️ ${caster.name} 消耗 ${hpCost} HP 發動【影之刺殺】，對 ${target.name} 造成 ${normalDmg} 傷害！`);
              }

              target.hp = Math.max(0, target.hp - normalDmg);
            }
          }

          broadcastRoomState(room.id);
          return;
        }

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
          : (data.isAoe ? room.players.filter(p => p.team !== caster.team && p.hp > 0) : [room.players.find(p => p.id === data.targetId) || room.players.filter(p => p.team !== caster.team && p.hp > 0)[0]]);

        targets = targets.filter(Boolean);
        let totalDamageDealt = 0;

        targets.forEach(t => {
          let rawVal = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;

          if (data.isHeal) {
            rawVal += intBonus;
            if (t.statusEffects && t.statusEffects.poison) rawVal = Math.floor(rawVal * 0.5);
            t.hp = Math.min(t.maxHp, t.hp + rawVal);
            broadcastBattleLog(room.id, `💚 ${caster.name} 對 ${t.name} 使用【${data.skillName}】，恢復 ${rawVal} HP！`);
          } else {
            const targetAgi = (t.stats && t.stats.agi) || 0;
            if (Math.random() < (targetAgi * 0.008)) {
              broadcastBattleLog(room.id, `💨 ${t.name} 憑藉高超敏捷，成功閃避了 ${caster.name} 的【${data.skillName}】！`);
              return;
            }

            const statBonus = (caster.role === 'mage' || caster.role === 'priest') ? intBonus : strBonus;
            rawVal += statBonus;

            const isCrit = Math.random() < (0.05 + agiCritBonus);
            if (isCrit) rawVal = Math.floor(rawVal * 1.5);

            const finalDamage = applyDefenseReduction(rawVal, t.stats ? t.stats.vit : 0);

            t.hp = Math.max(0, t.hp - finalDamage);
            totalDamageDealt += finalDamage;

            if (isCrit) {
              broadcastBattleLog(room.id, `💥⚡ ${caster.name} 觸發【暴擊】！對 ${t.name} 使用【${data.skillName}】，造成 ${finalDamage} 傷害！`);
            } else {
              broadcastBattleLog(room.id, `💥 ${caster.name} 對 ${t.name} 使用【${data.skillName}】，造成 ${finalDamage} 傷害！`);
            }

            if (t.role === 'knight' && finalDamage > 0) {
              const reflectDmg = Math.floor(finalDamage * 0.05);
              caster.hp = Math.max(0, caster.hp - reflectDmg);
              broadcastBattleLog(room.id, `🏰 ${t.name} (騎士) 荊棘反傷，反彈 ${reflectDmg} 傷害！`);
            }

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

        if (data.lifesteal && totalDamageDealt > 0 && caster.hp > 0) {
          const lifestealAmount = Math.floor(totalDamageDealt * data.lifesteal);
          caster.hp = Math.min(caster.maxHp, caster.hp + lifestealAmount);
          broadcastBattleLog(room.id, `🩸 ${caster.name} 吸血回復了 ${lifestealAmount} HP！`);
        }

        const teamAAlive = room.players.some(p => p.team === 'A' && p.hp > 0);
        const teamBAlive = room.players.some(p => p.team === 'B' && p.hp > 0);

        if (!teamAAlive || !teamBAlive) {
          room.status = 'game_over';
          if (room.regenTimer) clearInterval(room.regenTimer);
          if (room.aiTimer) clearInterval(room.aiTimer);

          const winTeam = teamAAlive ? 'A' : 'B';
          const winTeamName = teamAAlive ? '🔵 隊伍 A' : '🔴 隊伍 B';
          broadcastBattleLog(room.id, `🏆 遊戲結束！【${winTeamName}】獲得了最終勝利！`);

          for (let p of room.players) {
            if (!p.isAi) {
              const isWinner = (p.team === winTeam);
              const delta = isWinner ? 30 : -20;
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
        }

        broadcastRoomState(room.id);
      }

      else if (data.type === 'use_potion') {
        const room = rooms[ws.roomId];
        if (!room) return;
        const p = room.players.find(p => p.id === ws.id);
        if (!p || p.hp <= 0) return;

        if (data.potionType === 'hp' && p.inventory.hpPotion > 0) {
          p.inventory.hpPotion--;
          let healAmount = 3000;
          if (p.statusEffects && p.statusEffects.poison) healAmount = Math.floor(healAmount * 0.5);
          p.hp = Math.min(p.maxHp, p.hp + healAmount);
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

      else if (data.type === 'go_idle') {
        if (ws.roomId && rooms[ws.roomId]) {
          const room = rooms[ws.roomId];
          room.players = room.players.filter(p => p.id !== ws.id);
          if (room.players.length === 0) {
            if (room.regenTimer) clearInterval(room.regenTimer);
            if (room.aiTimer) clearInterval(room.aiTimer);
            delete rooms[ws.roomId];
          } else {
            broadcastRoomState(ws.roomId);
          }
          ws.roomId = null;
        }
        ws.isIdle = true;
        if (ws.idleTimer) clearTimeout(ws.idleTimer);
        scheduleIdleReward(ws);
        ws.send(JSON.stringify({ type: 'returned_to_idle', message: '🧘 已回到大廳修練...' }));
      }
    } catch (err) {
      console.error("解析訊息錯誤：", err);
    }
  });

  ws.on('close', () => {
    matchQueue = matchQueue.filter(p => p.ws !== ws);
    matchQueue5v5 = matchQueue5v5.filter(p => p.ws !== ws);
    if (ws.idleTimer) clearTimeout(ws.idleTimer);
    if (ws.roomId && rooms[ws.roomId]) {
      const room = rooms[ws.roomId];
      room.players = room.players.filter(p => p.id !== ws.id);
      if (room.players.length === 0) {
        if (room.regenTimer) clearInterval(room.regenTimer);
        if (room.aiTimer) clearInterval(room.aiTimer);
        delete rooms[ws.roomId];
      } else {
        broadcastRoomState(ws.roomId);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`🚀 RPG 遊戲伺服器已啟動於 Port ${PORT}`);
});
