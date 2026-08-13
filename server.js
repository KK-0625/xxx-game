const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
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

function broadcastRoom(roomId, message) {
  if (rooms[roomId]) {
    rooms[roomId].players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) {
        p.ws.send(JSON.stringify(message));
      }
    });
  }
}

function stopBattleTimer(room) {
  if (room && room.battleTimer) {
    clearInterval(room.battleTimer);
    room.battleTimer = null;
  }
}

function removeFromMatchQueue(playerId) {
  matchQueue = matchQueue.filter(p => p.id !== playerId);
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

function checkGameOver(roomId) {
  const room = rooms[roomId];
  if (!room || room.status !== 'playing') return;

  const teamALive = room.players.some(p => p.team === 'A' && p.hp > 0);
  const teamBLive = room.players.some(p => p.team === 'B' && p.hp > 0);

  if (!teamALive || !teamBLive) {
    room.status = 'game_over';
    stopBattleTimer(room);
    const winner = teamALive ? '隊伍 A' : '隊伍 B';
    broadcastRoom(roomId, { type: 'game_over', message: `🏆 戰鬥結束！ ${winner} 獲得了勝利！` });
  }
}

function startRoomBattle(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  
  room.status = 'playing';
  stopBattleTimer(room);
  
  room.battleTimer = setInterval(() => {
    if (room.status === 'playing') {
      let needBroadcast = false;
      room.players.forEach(p => {
        if (p.hp > 0 && p.mp < p.maxMp) {
          const regenAmount = Math.max(10, Math.floor(p.maxMp * 0.03));
          p.mp = Math.min(p.maxMp, p.mp + regenAmount);
          needBroadcast = true;
        }
      });
      if (needBroadcast) {
        broadcastRoom(roomId, { type: 'room_state', status: room.status, players: getSanitizedPlayers(room.players) });
      }
    }
  }, 1000);

  broadcastRoom(roomId, { type: 'room_state', status: 'playing', players: getSanitizedPlayers(room.players) });
  broadcastRoom(roomId, { type: 'game_start', message: '⚔️ 戰鬥正式開始！(每秒將自動恢復少許 MP)' });
}

function processMatchmaking() {
  while (matchQueue.length >= 2) {
    const matchedPlayers = matchQueue.splice(0, 2);
    const roomId = 'M' + Math.floor(1000 + Math.random() * 9000).toString();

    rooms[roomId] = {
      status: 'waiting',
      players: [],
      battleTimer: null
    };

    matchedPlayers.forEach((p, idx) => {
      p.stopIdlePractice();
      p.roomId = roomId;
      p.team = idx === 0 ? 'A' : 'B';
      rooms[roomId].players.push(p);

      p.ws.send(JSON.stringify({
        type: 'match_found',
        roomId: roomId,
        player: getSanitizedPlayers([p])[0]
      }));
    });

    setTimeout(() => {
      startRoomBattle(roomId);
    }, 1500);
  }
}

wss.on('connection', (ws) => {
  let player = {
    id: Math.random().toString(36).substr(2, 9),
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
      if (isHp) {
        player.inventory.hpPotion += 1;
        ws.send(JSON.stringify({
          type: 'idle_reward',
          inventory: player.inventory,
          message: '🧘‍♂️ 修練中... 獲得了 🧪 HP 藥水 x1！'
        }));
      } else {
        player.inventory.mpPotion += 1;
        ws.send(JSON.stringify({
          type: 'idle_reward',
          inventory: player.inventory,
          message: '🧘‍♂️ 修練中... 獲得了 🧪 MP 藥水 x1！'
        }));
      }
    }, 10000);
  }

  startIdlePractice();

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'get_inventory') {
        ws.send(JSON.stringify({ type: 'inventory_update', inventory: player.inventory }));
      }

      else if (data.type === 'join_queue') {
        if (player.roomId) return;
        const stats = ROLE_STATS[data.role] || ROLE_STATS.warrior;
        player.name = data.name || '勇者';
        player.role = data.role;
        player.hp = player.maxHp = stats.maxHp;
        player.mp = player.maxMp = stats.maxMp;
        player.critRate = stats.critRate;
        player.critMult = stats.critMult;

        if (!matchQueue.some(p => p.id === player.id)) {
          matchQueue.push(player);
          ws.send(JSON.stringify({ type: 'queue_joined', queueCount: matchQueue.length }));
          processMatchmaking();
        }
      }

      else if (data.type === 'leave_queue') {
        removeFromMatchQueue(player.id);
        ws.send(JSON.stringify({ type: 'queue_left' }));
      }

      else if (data.type === 'create_room') {
        removeFromMatchQueue(player.id);
        player.stopIdlePractice();
        const roomId = Math.floor(1000 + Math.random() * 9000).toString();
        const stats = ROLE_STATS[data.role] || ROLE_STATS.warrior;

        player.name = data.name || '玩家';
        player.role = data.role;
        player.team = 'A';
        player.roomId = roomId;
        player.hp = player.maxHp = stats.maxHp;
        player.mp = player.maxMp = stats.maxMp;
        player.critRate = stats.critRate;
        player.critMult = stats.critMult;

        rooms[roomId] = { status: 'waiting', players: [player], battleTimer: null };

        ws.send(JSON.stringify({ type: 'room_created', roomId, player: getSanitizedPlayers([player])[0] }));
        broadcastRoom(roomId, { type: 'room_state', status: 'waiting', players: getSanitizedPlayers(rooms[roomId].players) });
      }

      else if (data.type === 'join_room') {
        removeFromMatchQueue(player.id);
        player.stopIdlePractice();
        const room = rooms[data.roomId];
        if (!room) return ws.send(JSON.stringify({ type: 'error', message: '房間不存在！' }));
        if (room.status !== 'waiting') return ws.send(JSON.stringify({ type: 'error', message: '遊戲進行中，無法加入！' }));

        const stats = ROLE_STATS[data.role] || ROLE_STATS.warrior;
        const countA = room.players.filter(p => p.team === 'A').length;
        const countB = room.players.filter(p => p.team === 'B').length;

        player.name = data.name || '玩家';
        player.role = data.role;
        player.team = countA <= countB ? 'A' : 'B';
        player.roomId = data.roomId;
        player.hp = player.maxHp = stats.maxHp;
        player.mp = player.maxMp = stats.maxMp;
        player.critRate = stats.critRate;
        player.critMult = stats.critMult;

        room.players.push(player);

        ws.send(JSON.stringify({ type: 'room_joined', roomId: data.roomId, player: getSanitizedPlayers([player])[0] }));
        broadcastRoom(data.roomId, { type: 'room_state', status: 'waiting', players: getSanitizedPlayers(room.players) });
        broadcastRoom(data.roomId, { type: 'battle_log', message: `👋 ${player.name} 加入了房間 (分配至 ${player.team} 隊)` });
      }

      else if (data.type === 'start_game') {
        const room = rooms[player.roomId];
        if (room && room.players[0].id === player.id) {
          startRoomBattle(player.roomId);
        }
      }

      else if (data.type === 'use_skill') {
        const room = rooms[player.roomId];
        if (!room || room.status !== 'playing' || player.hp <= 0) return;

        if (player.mp < data.mpCost) {
          return ws.send(JSON.stringify({ type: 'error', message: 'MP 不足！' }));
        }

        let target = null;

        if (!data.isAoe) {
          if (data.targetId) {
            target = room.players.find(p => p.id === data.targetId && p.hp > 0);
          }
          
          if (!target) {
            if (data.isHeal) {
              const allies = room.players.filter(p => p.team === player.team && p.hp > 0);
              if (allies.length > 0) {
                target = allies.reduce((prev, curr) => (curr.hp / curr.maxHp < prev.hp / prev.maxHp ? curr : prev));
              }
            } else {
              const enemies = room.players.filter(p => p.team !== player.team && p.hp > 0);
              if (enemies.length > 0) {
                target = enemies.reduce((prev, curr) => (curr.hp < prev.hp ? curr : prev));
              }
            }
          }

          if (!target) {
            return ws.send(JSON.stringify({ type: 'error', message: '場上沒有合適的目標！' }));
          }
        }

        player.mp -= data.mpCost;
        let baseVal = Math.floor(Math.random() * (data.maxVal - data.minVal + 1)) + data.minVal;
        
        const isCrit = Math.random() < player.critRate;
        const finalVal = isCrit ? Math.floor(baseVal * player.critMult) : baseVal;
        const critTag = isCrit ? ' 💥【暴擊！】' : '';
        const ultTag = data.isUlt ? ' 🌟【大招！】' : '';

        if (data.isAoe) {
          room.players.forEach(p => {
            if (p.hp > 0) {
              if (data.isHeal && p.team === player.team) {
                p.hp = Math.min(p.maxHp, p.hp + finalVal);
              } else if (!data.isHeal && p.team !== player.team) {
                p.hp = Math.max(0, p.hp - finalVal);
              }
            }
          });
          const actionText = data.isHeal ? '治療了全體友方' : '對全體敵方造成了';
          broadcastRoom(player.roomId, {
            type: 'battle_log',
            message: `✨ ${player.name} 釋放【${data.skillName}】${ultTag}${critTag}，${actionText} ${finalVal} 點效果！`
          });
        } else {
          if (data.isHeal) {
            target.hp = Math.min(target.maxHp, target.hp + finalVal);
            broadcastRoom(player.roomId, {
              type: 'battle_log',
              message: `💚 ${player.name} 對 ${target.name} 釋放【${data.skillName}】${ultTag}${critTag}，恢復了 ${finalVal} 點 HP！`
            });
          } else {
            target.hp = Math.max(0, target.hp - finalVal);
            broadcastRoom(player.roomId, {
              type: 'battle_log',
              message: `⚔️ ${player.name} 對 ${target.name} 釋放【${data.skillName}】${ultTag}${critTag}，造成了 ${finalVal} 點傷害！`
            });
          }
        }

        broadcastRoom(player.roomId, { type: 'room_state', status: room.status, players: getSanitizedPlayers(room.players) });
        checkGameOver(player.roomId);
      }

      else if (data.type === 'use_potion') {
        const room = rooms[player.roomId];
        if (!room || room.status !== 'playing' || player.hp <= 0) return;

        if (data.potionType === 'hp') {
          if (player.inventory.hpPotion <= 0) return ws.send(JSON.stringify({ type: 'error', message: '背包中沒有 HP 藥水！' }));
          player.inventory.hpPotion--;
          const healAmount = Math.floor(player.maxHp * 0.4);
          player.hp = Math.min(player.maxHp, player.hp + healAmount);
          broadcastRoom(player.roomId, { type: 'battle_log', message: `🧪 ${player.name} 使用了 HP 藥水，恢復了 ${healAmount} 點 HP！` });
        } else if (data.potionType === 'mp') {
          if (player.inventory.mpPotion <= 0) return ws.send(JSON.stringify({ type: 'error', message: '背包中沒有 MP 藥水！' }));
          player.inventory.mpPotion--;
          const mpAmount = Math.floor(player.maxMp * 0.5);
          player.mp = Math.min(player.maxMp, player.mp + mpAmount);
          broadcastRoom(player.roomId, { type: 'battle_log', message: `🧪 ${player.name} 使用了 MP 藥水，恢復了 ${mpAmount} 點 MP！` });
        }

        ws.send(JSON.stringify({ type: 'inventory_update', inventory: player.inventory }));
        broadcastRoom(player.roomId, { type: 'room_state', status: room.status, players: getSanitizedPlayers(room.players) });
      }

      else if (data.type === 'rematch') {
        const room = rooms[player.roomId];
        if (room) {
          stopBattleTimer(room);
          room.status = 'waiting';
          room.players.forEach(p => {
            const stats = ROLE_STATS[p.role] || ROLE_STATS.warrior;
            p.hp = p.maxHp = stats.maxHp;
            p.mp = p.maxMp = stats.maxMp;
          });
          broadcastRoom(player.roomId, { type: 'room_state', status: room.status, players: getSanitizedPlayers(room.players) });
          broadcastRoom(player.roomId, { type: 'battle_log', message: '🔄 === 戰鬥狀態已重置，準備重新開局！ ===' });
        }
      }

      else if (data.type === 'go_idle') {
        leaveRoom(player);
        startIdlePractice();
        ws.send(JSON.stringify({ type: 'returned_to_idle', message: '已離開房間，返回修練狀態 (掛機獲得藥水中...)' }));
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.on('close', () => {
    removeFromMatchQueue(player.id);
    player.stopIdlePractice();
    leaveRoom(player);
  });
});

console.log(`🚀 WebSocket 伺服器已啟動於 Port: ${PORT}`);
