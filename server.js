const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');

// 初始化 SQLite 資料庫 (持久化玩家數據)
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

// 儲存目前記憶體狀態 (保留你原本的命名結構)
let users = {};              // 記憶體快取：username -> userData
let onlineUsers = new Map(); // username -> ws
let queue = [];              // 1v1 匹配隊列
let rooms = new Map();       // roomId -> roomState

// 升級所需經驗值公式 (保留你原本的 1.5 次方公式)
function getMaxExp(level) {
  return Math.floor(100 * Math.pow(level || 1, 1.5));
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
              // 同步更新記憶體與前端
              ws.user.gold = newGold;
              ws.user.exp = newExp;
              ws.user.level = newLevel;

              ws.send(JSON.stringify({
                type: 'idle_reward',
                message: `✨ 修練收益：金幣 +${goldGain}, 經驗 +${expGain}`,
                level: newLevel,
                exp: newExp,
                inventory: {
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

// WebSocket 連線處理
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // --- 1. 帳號註冊 ---
      if (data.type === 'register') {
        const { username, password, name, role } = data;
        db.get(`SELECT username FROM users WHERE username = ?`, [username], (err, row) => {
          if (row) {
            return ws.send(JSON.stringify({ type: 'error', message: '❌ 該帳號已被註冊！' }));
          }
          db.run(
            `INSERT INTO users (username, password, name, role, last_online) VALUES (?, ?, ?, ?, ?)`,
            [username, password, name, role || 'berserker', Date.now()],
            (err) => {
              if (err) return ws.send(JSON.stringify({ type: 'error', message: '註冊失敗！' }));
              ws.send(JSON.stringify({ type: 'register_success', message: '🎉 註冊成功，請進行登入！' }));
            }
          );
        });
      }

      // --- 2. 帳號登入 ---
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

          ws.send(JSON.stringify({
            type: 'login_success',
            user: {
              username: user.username,
              name: user.name,
              role: user.role,
              level: user.level,
              exp: user.exp,
              inventory: {
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

      // --- 3. 大廳聊天 ---
      else if (data.type === 'lobby_chat') {
        if (!ws.user) return;
        broadcastLobby({
          type: 'lobby_chat',
          sender: ws.user.name,
          message: data.message,
          time: new Date().toLocaleTimeString()
        });
      }

      // --- 4. 商店購買 (相容前端 hpPotion / hp_potion 兩種傳送格式) ---
      else if (data.type === 'buy_item') {
        if (!ws.user) return;
        
        // 映射前端格式
        const itemMap = {
          'hpPotion': 'hp_potion',
          'mpPotion': 'mp_potion',
          'expScroll': 'exp_scroll'
        };
        const itemType = itemMap[data.itemType] || data.itemType || itemMap[data.itemKey] || data.itemKey;
        
        const prices = { hp_potion: 10, mp_potion: 10, exp_scroll: 50 };
        const price = prices[itemType];

        if (!price) return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 查無此商品！' }));

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (user.gold < price) {
            return ws.send(JSON.stringify({ type: 'error', message: '💰 金幣不足！' }));
          }

          const newGold = user.gold - price;
          const newItemCount = user[itemType] + 1;

          db.run(`UPDATE users SET gold = ?, ${itemType} = ? WHERE username = ?`, [newGold, newItemCount, ws.username], (err) => {
            if (!err) {
              user.gold = newGold;
              user[itemType] = newItemCount;
              ws.user = user;

              ws.send(JSON.stringify({
                type: 'shop_success',
                message: `🛒 購買成功！`,
                inventory: {
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

      // --- 5. 使用經驗卷軸 (新增後端 DB 寫入與升級判斷) ---
      else if (data.type === 'use_exp_scroll') {
        if (!ws.user) return;

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (!user || user.exp_scroll <= 0) {
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 經驗卷軸數量不足！' }));
          }

          let newExpScroll = user.exp_scroll - 1;
          let newExp = user.exp + 150;
          let newLevel = user.level;
          let maxExp = getMaxExp(newLevel);

          while (newExp >= maxExp) {
            newExp -= maxExp;
            newLevel++;
            maxExp = getMaxExp(newLevel);
          }

          db.run(`UPDATE users SET exp_scroll = ?, exp = ?, level = ? WHERE username = ?`,
            [newExpScroll, newExp, newLevel, ws.username], (err) => {
              if (!err) {
                ws.user.exp_scroll = newExpScroll;
                ws.user.exp = newExp;
                ws.user.level = newLevel;

                ws.send(JSON.stringify({
                  type: 'idle_reward',
                  message: `📜 使用了經驗卷軸，獲得 +150 EXP！`,
                  level: newLevel,
                  exp: newExp,
                  inventory: {
                    gold: user.gold,
                    hpPotion: user.hp_potion,
                    mpPotion: user.mp_potion,
                    expScroll: newExpScroll
                  }
                }));
              }
            });
        });
      }

      // --- 6. 1v1 隨機配對 ---
      else if (data.type === 'join_queue') {
        if (queue.includes(ws)) return;
        queue.push(ws);
        ws.send(JSON.stringify({ type: 'queue_joined' }));

        if (queue.length >= 2) {
          const p1 = queue.shift();
          const p2 = queue.shift();
          const roomId = 'room_' + Date.now();

          p1.roomId = roomId;
          p2.roomId = roomId;

          // 保留你原本職業屬性初始化邏輯
          const roleStats = {
            berserker: { hp: 6000, mp: 1500 },
            mage: { hp: 3500, mp: 4000 },
            paladin: { hp: 5000, mp: 2500 }
          };

          const p1Role = p1.user.role || 'berserker';
          const p2Role = p2.user.role || 'berserker';

          const roomData = {
            roomId,
            players: [
              {
                id: 'p1',
                name: p1.user.name,
                role: p1Role,
                team: 'A',
                hp: roleStats[p1Role].hp,
                maxHp: roleStats[p1Role].hp,
                mp: roleStats[p1Role].mp,
                maxMp: roleStats[p1Role].mp,
                isDead: false,
                ws: p1
              },
              {
                id: 'p2',
                name: p2.user.name,
                role: p2Role,
                team: 'B',
                hp: roleStats[p2Role].hp,
                maxHp: roleStats[p2Role].hp,
                mp: roleStats[p2Role].mp,
                maxMp: roleStats[p2Role].mp,
                isDead: false,
                ws: p2
              }
            ]
          };

          rooms.set(roomId, roomData);

          p1.send(JSON.stringify({ type: 'match_found', roomId, player: { id: 'p1', ...roomData.players[0] } }));
          p2.send(JSON.stringify({ type: 'match_found', roomId, player: { id: 'p2', ...roomData.players[1] } }));

          broadcastRoomState(roomId);
        }
      }

      // --- 7. 取消匹配 ---
      else if (data.type === 'leave_queue') {
        queue = queue.filter(socket => socket !== ws);
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      // --- 8. 自訂房間 (建立/加入) 保留你原本邏輯 ---
      else if (data.type === 'join_custom_room') {
        const { customRoomId } = data;
        let room = rooms.get(customRoomId);

        if (!room) {
          const roleStats = { berserker: { hp: 6000, mp: 1500 }, mage: { hp: 3500, mp: 4000 }, paladin: { hp: 5000, mp: 2500 } };
          const role = ws.user.role || 'berserker';

          room = {
            roomId: customRoomId,
            players: [{
              id: 'p1',
              name: ws.user.name,
              role: role,
              team: 'A',
              hp: roleStats[role].hp,
              maxHp: roleStats[role].hp,
              mp: roleStats[role].mp,
              maxMp: roleStats[role].mp,
              isDead: false,
              ws: ws
            }]
          };
          rooms.set(customRoomId, room);
          ws.roomId = customRoomId;
          ws.send(JSON.stringify({ type: 'room_created', roomId: customRoomId, player: { id: 'p1', ...room.players[0] } }));
        } else if (room.players.length < 2) {
          const roleStats = { berserker: { hp: 6000, mp: 1500 }, mage: { hp: 3500, mp: 4000 }, paladin: { hp: 5000, mp: 2500 } };
          const role = ws.user.role || 'berserker';

          const newPlayer = {
            id: 'p2',
            name: ws.user.name,
            role: role,
            team: 'B',
            hp: roleStats[role].hp,
            maxHp: roleStats[role].hp,
            mp: roleStats[role].mp,
            maxMp: roleStats[role].mp,
            isDead: false,
            ws: ws
          };
          room.players.push(newPlayer);
          ws.roomId = customRoomId;
          ws.send(JSON.stringify({ type: 'room_joined', roomId: customRoomId, player: { id: 'p2', ...newPlayer } }));
        } else {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 該房間已滿！' }));
        }

        broadcastRoomState(customRoomId);
      }

      // --- 9. 戰鬥：使用技能 (完整保留你的各種效果/吸血/復活/AOE判斷) ---
      else if (data.type === 'use_skill') {
        if (!ws.roomId) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;

        const caster = room.players.find(p => p.ws === ws);
        if (!caster || caster.isDead) return;

        if (caster.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: '💧 魔力 (MP) 不足！' }));
        }

        caster.mp -= data.mpCost;
        let val = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;

        // 復活技能
        if (data.isRevive) {
          let deadAlly = room.players.find(p => p.team === caster.team && p.isDead);
          if (deadAlly) {
            deadAlly.isDead = false;
            deadAlly.hp = val;
            broadcastBattleLog(room.roomId, `✨ ${caster.name} 使用了【${data.skillName}】，復活了 ${deadAlly.name} 並回復 ${val} HP！`);
          } else {
            caster.mp += data.mpCost; // 無對象退回 MP
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 沒有陣亡的隊友可復活！' }));
          }
        }
        // 治癒技能
        else if (data.isHeal) {
          let target = room.players.find(p => p.id === data.targetId && p.team === caster.team && !p.isDead) || caster;
          target.hp = Math.min(target.maxHp, target.hp + val);
          broadcastBattleLog(room.roomId, `💖 ${caster.name} 對 ${target.name} 使用了【${data.skillName}】，恢復了 ${val} 生命值！`);
        }
        // 攻擊技能
        else {
          let targets = [];
          if (data.isAoe) {
            targets = room.players.filter(p => p.team !== caster.team && !p.isDead);
          } else {
            let t = room.players.find(p => p.id === data.targetId && p.team !== caster.team && !p.isDead) ||
                    room.players.find(p => p.team !== caster.team && !p.isDead);
            if (t) targets.push(t);
          }

          targets.forEach(target => {
            target.hp = Math.max(0, target.hp - val);
            if (target.hp === 0) target.isDead = true;

            // 吸血邏輯
            if (data.lifesteal) {
              let healAmt = Math.floor(val * data.lifesteal);
              caster.hp = Math.min(caster.maxHp, caster.hp + healAmt);
              broadcastBattleLog(room.roomId, `⚔️ ${caster.name} 對 ${target.name} 使用了【${data.skillName}】，造成 ${val} 傷害，並吸取了 ${healAmt} HP！`);
            } else {
              broadcastBattleLog(room.roomId, `⚔️ ${caster.name} 對 ${target.name} 使用了【${data.skillName}】，造成 ${val} 點傷害！`);
            }
          });
        }

        broadcastRoomState(room.roomId);
      }

      // --- 10. 戰鬥：使用藥水 (寫入 DB 扣除數量) ---
      else if (data.type === 'use_potion') {
        if (!ws.roomId || !ws.user) return;
        const room = rooms.get(ws.roomId);
        if (!room) return;
        const caster = room.players.find(p => p.ws === ws);
        if (!caster || caster.isDead) return;

        const potionType = data.potionType === 'hp' ? 'hp_potion' : 'mp_potion';

        db.get(`SELECT * FROM users WHERE username = ?`, [ws.username], (err, user) => {
          if (!user || user[potionType] <= 0) {
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 藥水數量不足！' }));
          }

          let newCount = user[potionType] - 1;
          db.run(`UPDATE users SET ${potionType} = ? WHERE username = ?`, [newCount, ws.username], (err) => {
            if (!err) {
              if (data.potionType === 'hp') {
                caster.hp = Math.min(caster.maxHp, caster.hp + 3000);
              } else {
                caster.mp = Math.min(caster.maxMp, caster.mp + 1500);
              }

              broadcastBattleLog(room.roomId, `🧪 ${caster.name} 使用了 ${data.potionType.toUpperCase()} 藥水！`);
              broadcastRoomState(room.roomId);

              ws.send(JSON.stringify({
                type: 'shop_success',
                message: `🧪 使用成功！`,
                inventory: {
                  gold: user.gold,
                  hpPotion: potionType === 'hp_potion' ? newCount : user.hp_potion,
                  mpPotion: potionType === 'mp_potion' ? newCount : user.mp_potion,
                  expScroll: user.exp_scroll
                }
              }));
            }
          });
        });
      }

      // --- 11. 離開戰鬥房間 ---
      else if (data.type === 'leave_room') {
        if (ws.roomId) {
          rooms.delete(ws.roomId);
          ws.roomId = null;
          ws.send(JSON.stringify({ type: 'returned_to_idle', message: '🚪 已離開戰鬥房間，回到大廳。' }));
        }
      }

    } catch (e) {
      console.error('訊息處理例外:', e);
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
  console.log(`🚀 原版邏輯 + 數據持久化 RPG 後端伺服器已啟動：http://localhost:${PORT}`);
});
