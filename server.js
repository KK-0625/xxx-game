// --- 1. 資料庫初始化 (包含 level, exp 與背包欄位) ---
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
        gold INT DEFAULT 0,
        level INT DEFAULT 1,
        exp INT DEFAULT 0,
        rank_points INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    // 確保舊資料表也能自動補上欄位
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INT DEFAULT 1;`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS exp INT DEFAULT 0;`);

    console.log("🟢 資料庫連線並初始化成功！");
  } catch (err) {
    console.error("🔴 資料庫初始化失敗：", err);
  }
}

// --- 2. 掛機修練獎勵與自動獲得經驗/升級機制 (每 1~5 分鐘觸發) ---
function scheduleIdleReward(client) {
  const randomDelay = Math.floor(Math.random() * (300000 - 60000 + 1)) + 60000;

  client.idleTimer = setTimeout(async () => {
    if (client.readyState === WebSocket.OPEN && client.user && client.isIdle) {
      const isHp = Math.random() > 0.5;
      const potionCol = isHp ? 'hp_potion' : 'mp_potion';
      const potionName = isHp ? 'HP 藥水 x1' : 'MP 藥水 x1';
      const goldEarned = Math.floor(Math.random() * 5) + 1; // 獲得 1 ~ 5 金幣
      const expEarned = Math.floor(Math.random() * 30) + 20; // 獲得 20 ~ 50 經驗值

      try {
        const userRes = await pool.query('SELECT level, exp, hp_potion, mp_potion, exp_scroll, gold, rank_points FROM users WHERE id = $1', [client.user.id]);
        let userRow = userRes.rows[0];

        let currentLevel = userRow.level;
        let currentExp = userRow.exp + expEarned;
        let nextExpReq = Math.floor(100 * Math.pow(currentLevel, 1.5));
        let leveledUp = false;

        // 循環檢查升級（支援一次獲得大量經驗時連續升等）
        while (currentExp >= nextExpReq) {
          currentExp -= nextExpReq;
          currentLevel += 1;
          leveledUp = true;
          nextExpReq = Math.floor(100 * Math.pow(currentLevel, 1.5));
        }

        // 更新資料庫
        const updateRes = await pool.query(
          `UPDATE users 
           SET ${potionCol} = ${potionCol} + 1, 
               gold = gold + $1, 
               exp = $2, 
               level = $3 
           WHERE id = $4 
           RETURNING hp_potion, mp_potion, exp_scroll, gold, rank_points, level, exp`,
          [goldEarned, currentExp, currentLevel, client.user.id]
        );

        const inv = updateRes.rows[0];
        client.user.inventory = {
          hpPotion: inv.hp_potion,
          mpPotion: inv.mp_potion,
          expScroll: inv.exp_scroll,
          gold: inv.gold
        };
        client.user.level = inv.level;
        client.user.exp = inv.exp;

        let msg = `🧘 修練中... 獲得了 🧪 ${potionName}、 ${goldEarned} 金幣、✨ ${expEarned} 經驗值！`;
        if (leveledUp) {
          msg += ` 🎉 恭喜升級！當前等級提升至 LV ${currentLevel}！`;
        }

        client.send(JSON.stringify({
          type: 'idle_reward',
          message: msg,
          inventory: client.user.inventory,
          level: client.user.level,
          exp: client.user.exp,
          nextExp: Math.floor(100 * Math.pow(client.user.level, 1.5))
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

// --- 3. WebSocket 訊息分發 (在 switch (data.type) 內加入 shop 購買邏輯) ---
// switch (data.type) {
//   ...
  
      else if (data.type === 'buy_item') {
        const { itemType } = data; // 'hp_potion', 'mp_potion', 'exp_scroll'
        
        // 商品價格表設定 (HP與MP皆為 10 金幣)
        const shopPrices = {
          hp_potion: 10,
          mp_potion: 10,
          exp_scroll: 50
        };

        const cost = shopPrices[itemType];
        if (!cost) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 查無此商品！' }));
        }

        if (!ws.user) {
          return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 請先登入才能購買道具！' }));
        }

        try {
          const userRes = await pool.query('SELECT gold, hp_potion, mp_potion, exp_scroll FROM users WHERE id = $1', [ws.user.id]);
          const dbUser = userRes.rows[0];

          if (dbUser.gold < cost) {
            return ws.send(JSON.stringify({ type: 'error', message: '⚠️ 您的金幣不足，無法購買！' }));
          }

          // 扣除金幣並增加道具
          const updateRes = await pool.query(
            `UPDATE users 
             SET gold = gold - $1, ${itemType} = ${itemType} + 1 
             WHERE id = $2 
             RETURNING gold, hp_potion, mp_potion, exp_scroll`,
            [cost, ws.user.id]
          );

          const updated = updateRes.rows[0];

          ws.user.inventory = {
            hpPotion: updated.hp_potion,
            mpPotion: updated.mp_potion,
            expScroll: updated.exp_scroll,
            gold: updated.gold
          };

          ws.send(JSON.stringify({
            type: 'shop_success',
            message: `🛍️ 購買成功！消耗了 ${cost} 金幣。`,
            inventory: ws.user.inventory
          }));

        } catch (err) {
          console.error("商店購買失敗:", err);
          ws.send(JSON.stringify({ type: 'error', message: '⚠️ 購買失敗，請稍後再試。' }));
        }
      }
// }
