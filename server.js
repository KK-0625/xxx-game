const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');

// 初始化 SQLite 資料庫
const db = new sqlite3.Database('./game_database.db', (err) => {
  if (err) console.error('❌ 資料庫連接失敗:', err.message);
  else console.log('📦 已成功連接至 SQLite 資料庫');
});

// 建立資料表
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'berserker',
      level INTEGER DEFAULT 1,
      exp INTEGER DEFAULT 0,
      gold INTEGER DEFAULT 100,
      hp_potion INTEGER DEFAULT 5,
      mp_potion INTEGER DEFAULT 5,
      exp_scroll INTEGER DEFAULT 1,
      last_online INTEGER
    )
  `);
});

const server = http.createServer();
const wss = new WebSocket.Server({ server });

let users = {};
let onlineUsers = new Map();
let queue = [];
let rooms = new Map();

// 🎯 對齊前端經驗公式：level * 100 (例如 LV.11 為 1100)
function getMaxExp(level) {
  return (level || 1) * 100;
}

// 廣播給大廳玩家
function broadcastLobby(data) {
  const payload = JSON.stringify(data);
  for (let [_, socket] of onlineUsers) {
    if (socket.readyState === WebSocket.OPEN && !socket.roomId) {
      socket.send(payload);
    }
  }
}

// 廣播房間狀態
function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = JSON.stringify({ type: 'room_state', ...room });
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  });
}

// 廣播戰鬥日誌
function broadcastBattleLog(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;

  const payload = JSON.stringify({ type: 'battle_log', message });
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(payload);
    }
  });
}

// 伺服器掛機收益計時器 (每 10 秒發放一次)
setInterval(() => {
  const now = Date.now();
  for (let [username, ws] of onlineUsers) {
    if (ws.readyState === WebSocket.OPEN && !ws.roomId && ws.user) {
      db.get(`SELECT * FROM users WHERE username = ?`, [username], (err, dbUser) => {
        if (!dbUser) return;

        let goldGain = Math.floor(Math.random() * 5) + 5;
        let expGain = Math.floor(Math.random() * 10) + 10;
        let newGold = dbUser.gold + goldGain;
        let newExp = dbUser.exp + expGain;
        let newLevel = dbUser.level;

        let maxExp = getMaxExp(newLevel);
        while (newExp >= maxExp) {
          newExp -= maxExp;
          newLevel++;
          maxExp = getMaxExp(newLevel);
        }

        db.run(
          `UPDATE users SET gold = ?, exp = ?, level = ?, last_online = ? WHERE username = ?`,
          [newGold, newExp, newLevel, now, username],
          (err) => {
            if (!err) {
              // 同步記憶體
              ws.user.gold = newGold;
              ws.user.exp = newExp;
              ws.user.level = newLevel;

              // 🎯 回傳前端 addExp 能正確吃的 gainedExp，並夾帶即時背包
              ws.send(JSON.stringify({
                type: 'idle_reward',
                message: `✨ 修練收益：金幣 +${goldGain}, 經驗 +${expGain}`,
                gainedExp: expGain, 
                inventory: {
                  level: newLevel,
                  exp: newExp,
                  gold: newGold,
                  hpPotion: dbUser.hp_potion,
                  mpPotion: dbUser.mp_potion,
                  expScroll: dbUser.exp_scroll
                }
              }));
            }
          }
        );
      });
    }
  }
}, 10000);

// WebSocket 訊息監聽
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // --- 1. 註冊 ---
      if (data.type === 'register') {
        const { username, password } = data;
        db.get(`SELECT username FROM users WHERE username = ?`, [username], (err, row) => {
          if (row) {
            return ws.send(JSON.stringify({ type: 'error', message: '❌ 該帳號已被註冊！' }));
          }
          db.run(
            `INSERT INTO users (username, password, name, role, last_online) VALUES (?, ?, ?, ?, ?)`,
            [username, password, username, 'berserker', Date.now()],
            (err) => {
              if (err) return ws.send(JSON.stringify({ type: 'error', message: '註冊失敗！' }));
              ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功，請進行登入！' }));
            }
          );
        });
      }

      // --- 2. 登入 ---
      else if (data.type === 'login') {
        const { username, password } = data;
        db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
          if (!user) {
            return ws.send(JSON.stringify({ type: 'error', message: '❌ 帳號或密碼錯誤！' }));
          }

          ws.username = username;
          ws.user = user;
          users[username] = user;
          onlineUsers.set(username, ws);

          // 回傳給前端 login_success (包含 level, exp 及完整背包)
          ws.send(JSON.stringify({
            type: 'login_success',
            user: {
              username: user.username,
              name: user.name,
              role: user.role,
              level: user.level,
              exp: user.exp,
              inventory: {
                level: user.level,
                exp: user.exp,
                gold: user.gold,
                hpPotion: user.hp_potion,
                mpPotion: user.mp_potion,
                expScroll: user.exp_scroll
              }
            }
          }));

          broadcastLobby({ type: 'online_count', onlineCount: onlineUsers.size });
        });
      }

      // --- 3. 聊天 ---
      else if (data.type === 'send_lobby_chat') {
        if (!ws.user) return;
        broadcastLobby({
          type: 'lobby_chat',
          sender: data.name || ws.user.name,
          message: data.message,
          time: new Date().toLocaleTimeString()
        });
      }

      // --- 4. 商店購買 (扣款並更新 DB) ---
      else if (data.type === 'buy_item') {
        if (!ws.user) return;
        
        const itemMap = { 'hpPotion': 'hp_potion', 'mpPotion': 'mp_potion', 'expScroll': 'exp_scroll' };
        const dbField = itemMap[data.itemKey];
        const price = data.price || 50;

        if (!dbField) return;

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (user.gold < price) {
            return ws.send(JSON.stringify({ type: 'error', message: '💰 金幣不足！' }));
          }

          const newGold = user.gold - price;
          const newItemCount = user[dbField] + 1;

          db.run(`UPDATE users SET gold = ?, ${dbField} = ? WHERE username = ?`, [newGold, newItemCount, ws.username], (err) => {
            if (!err) {
              user.gold = newGold;
              user[dbField] = newItemCount;
              ws.user = user;

              ws.send(JSON.stringify({
                type: 'idle_reward',
                message: `🛒 購買成功！`,
                inventory: {
                  level: user.level,
                  exp: user.exp,
                  gold: user.gold,
                  hpPotion: user.hp_potion,
                  mpPotion: user.mp_potion,
                  expScroll: user.exp_scroll
                }
              }));
            }
          });
        });
      }

      // --- 5. 使用經驗卷軸 (同步寫入 DB) ---
      else if (data.type === 'use_exp_scroll') {
        if (!ws.user) return;

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (!user || user.exp_scroll <= 0) return;

          let newScroll = user.exp_scroll - 1;
          let newExp = user.exp + 150;
          let newLevel = user.level;
          let maxExp = getMaxExp(newLevel);

          while (newExp >= maxExp) {
            newExp -= maxExp;
            newLevel++;
            maxExp = getMaxExp(newLevel);
          }

          db.run(`UPDATE users SET exp_scroll = ?, exp = ?, level = ? WHERE username = ?`,
            [newScroll, newExp, newLevel, ws.username], (err) => {
              if (!err) {
                ws.user.exp_scroll = newScroll;
                ws.user.exp = newExp;
                ws.user.level = newLevel;

                ws.send(JSON.stringify({
                  type: 'idle_reward',
                  message: `📜 使用經驗卷軸！+150 EXP`,
                  gainedExp: 150,
                  inventory: {
                    level: newLevel,
                    exp: newExp,
                    gold: user.gold,
                    hpPotion: user.hp_potion,
                    mpPotion: user.mp_potion,
                    expScroll: newScroll
                  }
                }));
              }
            });
        });
      }

      // --- 6. 1v1 配對 (對齊前端 join_queue 參數格式) ---
      else if (data.type === 'join_queue') {
        if (queue.includes(ws)) return;
        if (data.name) ws.user.name = data.name;
        if (data.role) ws.user.role = data.role;

        queue.push(ws);
        ws.send(JSON.stringify({ type: 'queue_joined' }));

        if (queue.length >= 2) {
          const p1 = queue.shift();
          const p2 = queue.shift();
          const roomId = 'room_' + Date.now();

          p1.roomId = roomId;
          p2.roomId = roomId;

          const roleStats = {
            berserker: { hp: 16000, mp: 1500 },
            mage: { hp: 9000, mp: 4000 },
            priest: { hp: 10000, mp: 3000 },
            knight: { hp: 20000, mp: 2000 },
            assassin: { hp: 11000, mp: 2000 },
            archer: { hp: 10500, mp: 2200 }
          };

          const p1Role = p1.user.role || 'berserker';
          const p2Role = p2.user.role || 'berserker';

          const roomData = {
            roomId,
            status: 'playing',
            players: [
              {
                id: 'p1',
                name: p1.user.name,
                role: p1Role,
                team: 'A',
                level: p1.user.level || 1,
                hp: roleStats[p1Role].hp,
                maxHp: roleStats[p1Role].hp,
                mp: roleStats[p1Role].mp,
                maxMp: roleStats[p1Role].mp,
                inventory: { gold: p1.user.gold, hpPotion: p1.user.hp_potion, mpPotion: p1.user.mp_potion, expScroll: p1.user.exp_scroll },
                ws: p1
              },
              {
                id: 'p2',
                name: p2.user.name,
                role: p2Role,
                team: 'B',
                level: p2.user.level || 1,
                hp: roleStats[p2Role].hp,
                maxHp: roleStats[p2Role].hp,
                mp: roleStats[p2Role].mp,
                maxMp: roleStats[p2Role].mp,
                inventory: { gold: p2.user.gold, hpPotion: p2.user.hp_potion, mpPotion: p2.user.mp_potion, expScroll: p2.user.exp_scroll },
                ws: p2
              }
            ]
          };

          rooms.set(roomId, roomData);

          p1.send(JSON.stringify({ type: 'match_found', roomId, player: roomData.players[0] }));
          p2.send(JSON.stringify({ type: 'match_found', roomId, player: roomData.players[1] }));

          broadcastRoomState(roomId);
        }
      }

      // --- 7. 取消配對 ---
      else if (data.type === 'leave_queue') {
        queue = queue.filter(socket => socket !== ws);
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      // --- 8. 建立與加入自訂房間 ---
      else if (data.type === 'create_room' || data.type === 'join_room') {
        const roomId = data.roomId || 'room_' + Math.floor(Math.random() * 8999 + 1000);
        let room = rooms.get(roomId);

        if (data.name) ws.user.name = data.name;
        if (data.role) ws.user.role = data.role;

        const roleStats = {
          berserker: { hp: 16000, mp: 1500 },
          mage: { hp: 9000, mp: 4000 },
          priest: { hp: 10000, mp: 3000 },
          knight: { hp: 20000, mp: 2000 },
          assassin: { hp: 11000, mp: 2000 },
          archer: { hp: 10500, mp: 2200 }
        };
        const role = ws.user.role || 'berserker';

        if (!room) {
          room = {
            roomId,
            status: 'waiting',
            players: [{
              id: 'p1',
              name: ws.user.name,
              role: role,
              team: data.team || 'A',
              level: ws.user.level || 1,
              hp: roleStats[role].hp,
              maxHp: roleStats[role].hp,
              mp: roleStats[role].mp,
              maxMp: roleStats[role].mp,
              inventory: { gold: ws.user.gold, hpPotion: ws.user.hp_potion, mpPotion: ws.user.mp_potion, expScroll: ws.user.exp_scroll },
              ws: ws
            }]
          };
          rooms.set(roomId, room);
          ws.roomId = roomId;
          ws.send(JSON.stringify({ type: 'room_created', roomId, player: room.players[0] }));
        } else if (room.players.length < 4) {
          const pId = 'p' + (room.players.length + 1);
          const newPlayer = {
            id: pId,
            name: ws.user.name,
            role: role,
            team: data.targetTeam || 'B',
            level: ws.user.level || 1,
            hp: roleStats[role].hp,
            maxHp: roleStats[role].hp,
            mp: roleStats[role].mp,
            maxMp: roleStats[role].mp,
            inventory: { gold: ws.user.gold, hpPotion: ws.user.hp_potion, mpPotion: ws.user.mp_potion, expScroll: ws.user.exp_scroll },
            ws: ws
          };
          room.players.push(newPlayer);
          ws.roomId = roomId;
          ws.send(JSON.stringify({ type: 'room_joined', roomId, player: newPlayer }));
        } else {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 房間已滿！' }));
        }

        broadcastRoomState(roomId);
      }

      // --- 9. 使用技能 (完美相容前端多職業) ---
      else if (data.type === 'use_skill') {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;

        const caster = room.players.find(p => p.ws === ws);
        if (!caster || caster.hp <= 0) return;

        if (caster.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: '💧 魔力 (MP) 不足！' }));
        }

        caster.mp -= data.mpCost;
        let val = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;

        if (data.isRevive) {
          let deadAlly = room.players.find(p => p.team === caster.team && p.hp <= 0);
          if (deadAlly) {
            deadAlly.hp = deadAlly.maxHp * 0.5;
            broadcastBattleLog(room.roomId, `✨ ${caster.name} 使用了【${data.skillName}】，復活了 ${deadAlly.name}！`);
          } else {
            caster.mp += data.mpCost;
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 沒有陣亡的隊友可復活！' }));
          }
        } else if (data.isHeal) {
          let target = room.players.find(p => p.id === data.targetId && p.team === caster.team && p.hp > 0) || caster;
          target.hp = Math.min(target.maxHp, target.hp + val);
          broadcastBattleLog(room.roomId, `💖 ${caster.name} 對 ${target.name} 使用【${data.skillName}】，恢復 ${val} HP！`);
        } else {
          let targets = [];
          if (data.isAoe) {
            targets = room.players.filter(p => p.team !== caster.team && p.hp > 0);
          } else {
            let t = room.players.find(p => p.id === data.targetId && p.team !== caster.team && p.hp > 0) ||
                    room.players.find(p => p.team !== caster.team && p.hp > 0);
            if (t) targets.push(t);
          }

          targets.forEach(target => {
            target.hp = Math.max(0, target.hp - val);

            if (data.lifesteal) {
              let healAmt = Math.floor(val * data.lifesteal);
              caster.hp = Math.min(caster.maxHp, caster.hp + healAmt);
              broadcastBattleLog(room.roomId, `⚔️ ${caster.name} 對 ${target.name} 使用【${data.skillName}】，造成 ${val} 傷害並吸取 ${healAmt} HP！`);
            } else {
              broadcastBattleLog(room.roomId, `⚔️ ${caster.name} 對 ${target.name} 使用【${data.skillName}】，造成 ${val} 傷害！`);
            }
          });
        }

        broadcastRoomState(room.roomId);
      }

      // --- 10. 使用藥水 (寫入 DB 扣除數量) ---
      else if (data.type === 'use_potion') {
        if (!ws.roomId || !ws.user) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const caster = room.players.find(p => p.ws === ws);
        if (!caster || caster.hp <= 0) return;

        const dbField = data.potionType === 'hp' ? 'hp_potion' : 'mp_potion';

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (!user || user[dbField] <= 0) {
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 藥水數量不足！' }));
          }

          let newCount = user[dbField] - 1;
          db.run(`UPDATE users SET ${dbField} = ? WHERE username = ?`, [newCount, ws.username], (err) => {
            if (!err) {
              user[dbField] = newCount;
              ws.user = user;

              if (data.potionType === 'hp') caster.hp = Math.min(caster.maxHp, caster.hp + 3000);
              else caster.mp = Math.min(caster.maxMp, caster.mp + 1500);

              broadcastBattleLog(room.roomId, `🧪 ${caster.name} 使用了 ${data.potionType.toUpperCase()} 藥水！`);
              
              // 更新玩家記憶體背包數據並廣播
              caster.inventory = {
                gold: user.gold,
                hpPotion: user.hp_potion,
                mpPotion: user.mp_potion,
                expScroll: user.exp_scroll
              };

              broadcastRoomState(room.roomId);
            }
          });
        });
      }

      // --- 11. 返回大廳 ---
      else if (data.type === 'go_idle') {
        if (ws.roomId) {
          rooms.delete(ws.roomId);
          ws.roomId = null;
          ws.send(JSON.stringify({ type: 'returned_to_idle', message: '🚪 已離開房間，回到大廳。' }));
        }
      }

    } catch (e) {
      console.error('解析例外:', e);
    }
  });

  ws.on('close', () => {
    if (ws.username) {
      delete users[ws.username];
      onlineUsers.delete(ws.username);
    }
    queue = queue.filter(socket => socket !== ws);
    broadcastLobby({ type: 'online_count', onlineCount: onlineUsers.size });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`🚀 RPG 後端伺服器已啟動：http://localhost:${PORT}`);
});
