
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3001;
const AOI_RADIUS = 800; // pixels

// Player and map data
const players = new Map(); // email -> player object
const mapPlayers = new Map(); // mapId -> Set of emails

// Monster data
const monsters = new Map(); // monsterId -> monster object
const mapMonsters = new Map(); // mapId -> Set of monsterIds


// Monster spawn config
const MONSTER_SPAWNS = {
  monster_field_1: {
    count: 20,
    types: ['poring', 'lunatic', 'fabre', 'chonchon'],
    bounds: { minX: 100, maxX: 2300, minY: 100, maxY: 1800 }
  }
};

const MONSTER_STATS = {
  poring: { hp: 50, attack: 5, speed: 1.5, aggro: 150, attackRange: 40, cooldown: 1500, xp: 5, loot: ['potion'] },
  lunatic: { hp: 60, attack: 8, speed: 2, aggro: 180, attackRange: 50, cooldown: 1300, xp: 8, loot: ['potion', 'coin'] },
  fabre: { hp: 45, attack: 6, speed: 1.8, aggro: 160, attackRange: 45, cooldown: 1400, xp: 6, loot: ['coin'] },
  chonchon: { hp: 55, attack: 7, speed: 2.2, aggro: 200, attackRange: 60, cooldown: 1200, xp: 10, loot: ['potion', 'coin', 'gem'] }
};

// Distance helper
function getDistance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

// Get players in AOI
function getPlayersInAOI(email, x, y, mapId) {
  const playersInMap = mapPlayers.get(mapId) || new Set();
  const nearby = [];

  for (const otherEmail of playersInMap) {
    if (otherEmail === email) continue;
    const p = players.get(otherEmail);
    if (!p) continue;
    if (getDistance(x, y, p.x, p.y) <= AOI_RADIUS) {
      nearby.push({
        email: p.email,
        name: p.name,
        character_class: p.character_class,
        level: p.level,
        position: { x: p.x, y: p.y },
        direction: p.direction,
        state: p.state
      });
    }
  }
  return nearby;
}

// Broadcast to AOI
function broadcastToAOI(email, x, y, mapId, event, data) {
  const playersInMap = mapPlayers.get(mapId) || new Set();
  for (const otherEmail of playersInMap) {
    if (otherEmail === email) continue;
    const p = players.get(otherEmail);
    if (!p || !p.socketId) continue;
    if (getDistance(x, y, p.x, p.y) <= AOI_RADIUS) {
      io.to(p.socketId).emit(event, data);
    }
  }
}

// Broadcast to entire map
function broadcastToMap(mapId, event, data) {
  const playersInMap = mapPlayers.get(mapId) || new Set();
  for (const email of playersInMap) {
    const p = players.get(email);
    if (p?.socketId) io.to(p.socketId).emit(event, data);
  }
}

// Cleanup monsters if map becomes empty
function cleanupMapIfEmpty(mapId) {
  const playersInMap = mapPlayers.get(mapId);

  if (playersInMap && playersInMap.size === 0) {
    const monsterSet = mapMonsters.get(mapId);

    if (monsterSet) {
      for (const monsterId of monsterSet) {
        monsters.delete(monsterId);
      }
      mapMonsters.delete(mapId);
    }

    console.log(`🧹 Cleared monsters for empty map ${mapId}`);
  }
}



// Spawn monsters (FIXED VERSION)
function spawnMonsters(mapId) {
  const config = MONSTER_SPAWNS[mapId];
  if (!config) return;

  // Ensure map monster set exists
  if (!mapMonsters.has(mapId)) {
    mapMonsters.set(mapId, new Set());
  }

  const monsterSet = mapMonsters.get(mapId);

  // Prevent over-spawning (important!)
  if (monsterSet.size >= config.count) return;

  for (let i = monsterSet.size; i < config.count; i++) {
    const type = config.types[Math.floor(Math.random() * config.types.length)];
    const stats = MONSTER_STATS[type];

    const monsterId = `${mapId}_${type}_${Date.now()}_${i}`;

    const x =
      config.bounds.minX +
      Math.random() * (config.bounds.maxX - config.bounds.minX);
    const y =
      config.bounds.minY +
      Math.random() * (config.bounds.maxY - config.bounds.minY);

    const monster = {
      id: monsterId,
      type,
      mapId, // 🔥 REQUIRED
      x,
      y,
      spawnX: x,
      spawnY: y,
      direction: 'front',
      state: 'idle',
      hp: stats.hp,
      maxHp: stats.hp,
      attack: stats.attack,
      speed: stats.speed,
      aggroRange: stats.aggro,
      attackRange: stats.attackRange,
      attackCooldown: stats.cooldown,
      lastAttack: 0,
      target: null,
      lastUpdate: Date.now()
    };

    monsters.set(monsterId, monster);
    monsterSet.add(monsterId);

    // 🔥 ALWAYS SEND mapId
    broadcastToMap(mapId, 'monster:spawn', {
      id: monsterId,
      type,
      mapId,
      x: monster.x,
      y: monster.y,
      hp: monster.hp,
      maxHp: monster.maxHp,
      direction: monster.direction,
      state: monster.state
    });
  }

  console.log(`✅ Monsters ensured for map ${mapId} (${monsterSet.size}/${config.count})`);
}

// ------------------ Monster AI (OPTIMIZED & SAFE) ------------------
function updateMonsterAI() {
  const now = Date.now();

  for (const [monsterId, monster] of monsters.entries()) {
    // ❌ Skip dead monsters
    if (monster.hp <= 0) continue;

    // ❌ Skip AI if map has no players
    const playersInMap = mapPlayers.get(monster.mapId);
    if (!playersInMap || playersInMap.size === 0) continue;

    let closestPlayer = null;
    let closestDist = Infinity;

    for (const email of playersInMap) {
      const p = players.get(email);
      if (!p || p.isDead) continue; // 🔥 skip dead players

      const dist = getDistance(monster.x, monster.y, p.x, p.y);
      if (dist < closestDist && dist < monster.aggroRange) {
        closestDist = dist;
        closestPlayer = p;
      }
    }

    if (closestPlayer && closestDist < monster.aggroRange) {
      monster.target = closestPlayer.email;

      // ------------------ CHASE ------------------
      if (closestDist > monster.attackRange) {
        const angle = Math.atan2(
          closestPlayer.y - monster.y,
          closestPlayer.x - monster.x
        );

        monster.x += Math.cos(angle) * monster.speed;
        monster.y += Math.sin(angle) * monster.speed;

        if (Math.abs(Math.cos(angle)) > Math.abs(Math.sin(angle))) {
          monster.direction = Math.cos(angle) > 0 ? 'right' : 'left';
        } else {
          monster.direction = Math.sin(angle) > 0 ? 'front' : 'back';
        }

        monster.state = 'chasing';

        if (now - monster.lastUpdate > 100) {
          broadcastToMap(monster.mapId, 'monster:move', {
            id: monsterId,
            mapId: monster.mapId,
            x: monster.x,
            y: monster.y,
            direction: monster.direction,
            state: monster.state
          });
          monster.lastUpdate = now;
        }

      // ------------------ ATTACK (UPDATED) ------------------
      } else {
        if (now - monster.lastAttack > monster.attackCooldown) {
          monster.state = 'attacking';
          monster.lastAttack = now;

          broadcastToMap(monster.mapId, 'monster:attack', {
            id: monsterId,
            mapId: monster.mapId,
            targetEmail: closestPlayer.email,
            damage: monster.attack,
            x: monster.x,
            y: monster.y,
            direction: monster.direction
          });

          // 🔥 SERVER-SIDE DAMAGE AUTHORITY
          const targetPlayer = players.get(closestPlayer.email);
          if (!targetPlayer || targetPlayer.isDead) continue;

          targetPlayer.hp -= monster.attack;
          targetPlayer.hp = Math.max(0, targetPlayer.hp);

          io.to(targetPlayer.socketId).emit('player:damaged', {
            hp: targetPlayer.hp,
            maxHp: targetPlayer.maxHp,
            damage: monster.attack
          });

          if (targetPlayer.hp === 0) {
            handlePlayerDeath(targetPlayer);
          }

          setTimeout(() => {
            monster.state = 'idle';
          }, 400);
        }
      }

    // ------------------ IDLE / WANDER ------------------
    } else {
      monster.target = null;
      monster.state = 'idle';

      if (Math.random() > 0.99 && now - monster.lastUpdate > 500) {
        const angle = Math.random() * Math.PI * 2;

        monster.x += Math.cos(angle) * 10;
        monster.y += Math.sin(angle) * 10;

        broadcastToMap(monster.mapId, 'monster:move', {
          id: monsterId,
          mapId: monster.mapId,
          x: monster.x,
          y: monster.y,
          direction: monster.direction,
          state: 'idle'
        });

        monster.lastUpdate = now;
      }
    }
  }
}

setInterval(updateMonsterAI, 100);


// ------------------ Player & Monster Broadcast (FIXED) ------------------

// Player AOI movement sync
setInterval(() => {
  for (const [email, player] of players.entries()) {
    if (!player.socketId) continue;

    broadcastToAOI(
      email,
      player.x,
      player.y,
      player.map,
      'player:moved',
      {
        email: player.email,
        name: player.name,
        character_class: player.character_class,
        position: { x: player.x, y: player.y },
        direction: player.direction,
        state: player.state,
        timestamp: Date.now()
      }
    );
  }
}, 50);


// Monster state sync (MAP-AWARE & SAFE)
setInterval(() => {
  for (const [monsterId, monster] of monsters.entries()) {
    if (monster.hp <= 0) continue;

    // 🔥 DO NOT broadcast if map has no players
    const playersInMap = mapPlayers.get(monster.mapId);
    if (!playersInMap || playersInMap.size === 0) continue;

    broadcastToMap(monster.mapId, 'monster:update', {
      id: monsterId,
      type: monster.type,
      mapId: monster.mapId,
      x: monster.x,
      y: monster.y,
      direction: monster.direction,
      state: monster.state,
      hp: monster.hp,
      maxHp: monster.maxHp,
      target: monster.target
    });
  }
}, 100); // 🔥 Slower = safer (10 updates/sec)

// ------------------ Socket.IO Events ------------------
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  let currentPlayer = null;

  socket.on('player:join', (data) => {
  const { email, name, character_class, level, position, map } = data;

  // 🔥 Calculate dynamic stats (MMORPG-style)
  const stats = calculatePlayerStats({
    character_class,
    level
  });

  currentPlayer = {
    email,
    name,
    character_class,
    level,

    // Position
    x: position.x,
    y: position.y,

    // State
    direction: 'front',
    state: 'idle',
    map,
    socketId: socket.id,
    lastUpdate: Date.now(),

    // 🔥 Dynamic combat stats
    hp: stats.maxHp,
    maxHp: stats.maxHp,
    attack: stats.attack,
    isDead: false,

    // Progression
    xp: 0,
    inventory: []
  };

  players.set(email, currentPlayer);

  // ------------------ MAP REGISTRATION ------------------
  if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
  mapPlayers.get(map).add(email);

  console.log(`Player ${name} joined map ${map}`);

  // ------------------ MONSTERS ------------------
  spawnMonsters(map);

  // Send existing monsters to this player
  const monstersInMap = mapMonsters.get(map) || new Set();
  for (const monsterId of monstersInMap) {
    const m = monsters.get(monsterId);
    if (m && m.hp > 0) {
      socket.emit('monster:spawn', { 
        id: m.id,
        type: m.type,
        mapId: m.mapId,
        x: m.x,
        y: m.y,
        hp: m.hp,
        maxHp: m.maxHp,
        direction: m.direction,
        state: m.state,
        spawnX: m.spawnX,
        spawnY: m.spawnY,
        target: m.target
      });
    }
  }

  // ------------------ NEARBY PLAYERS ------------------
  const nearby = getPlayersInAOI(email, position.x, position.y, map);
  nearby.forEach(p => socket.emit('player:joined', p));

  // Notify others in AOI
  broadcastToAOI(email, position.x, position.y, map, 'player:joined', { 
    email,
    name,
    character_class,
    level,
    position,
    direction: 'front',
    state: 'idle'
  });
});


  // ------------------ Player Attacks Monster (FIXED & SAFE) ------------------
socket.on('monster:hit', (data) => {
  if (!currentPlayer) return;

  const { monsterId, damage } = data;
  const monster = monsters.get(monsterId);
  if (!monster) return;

  // 🔥 Map authority check
  if (monster.mapId !== currentPlayer.map) return;

  // Apply damage
  monster.hp = Math.max(0, monster.hp - damage);
  monster.lastHitBy = currentPlayer.email;

  // Broadcast hit
  broadcastToMap(monster.mapId, 'monster:hit', {
    id: monsterId,
    mapId: monster.mapId,
    hp: monster.hp,
    damage
  });

  if (monster.hp > 0) return;

  // ------------------ MONSTER DEFEATED ------------------
  broadcastToMap(monster.mapId, 'monster:despawn', {
    id: monsterId,
    mapId: monster.mapId
  });

  const killer = players.get(monster.lastHitBy);
  if (killer) {
    const stats = MONSTER_STATS[monster.type];

    killer.xp += stats.xp;

    const lootItem =
      stats.loot[Math.floor(Math.random() * stats.loot.length)];
    killer.inventory.push(lootItem);

    io.to(killer.socketId).emit('monster:killed', {
      monsterId,
      xp: stats.xp,
      loot: lootItem
    });
  }

  // ------------------ SAFE RESPAWN ------------------
  setTimeout(() => {
    // 🔥 ABORT if monster was cleaned up
    if (!monsters.has(monsterId)) return;

    monster.hp = monster.maxHp;
    monster.x = monster.spawnX;
    monster.y = monster.spawnY;
    monster.state = 'idle';
    monster.target = null;

    broadcastToMap(monster.mapId, 'monster:spawn', {
      id: monsterId,
      type: monster.type,
      mapId: monster.mapId,
      x: monster.x,
      y: monster.y,
      hp: monster.hp,
      maxHp: monster.maxHp,
      direction: monster.direction,
      state: monster.state
    });
  }, 5000);
});



// ------------------ Player Movement (FINAL & CORRECT) ------------------
socket.on('player:move', (data) => {
  if (!currentPlayer) return;

  const { position, direction, state } = data;
  const now = Date.now();

  // Throttle input updates
  if (now - currentPlayer.lastUpdate < 40) return;

  // 🔥 Server-authoritative state update ONLY
  currentPlayer.x = position.x;
  currentPlayer.y = position.y;
  currentPlayer.direction = direction;
  currentPlayer.state = state;
  currentPlayer.lastUpdate = now;

  // ❌ DO NOT broadcast here
  // Movement is synced by the server tick loop
});



  // ------------------ Player Attack (SERVER AUTHORITATIVE) ------------------
socket.on('player:attack', (data) => {
  if (!currentPlayer) return;

  const { damage } = data;

  broadcastToAOI(
    currentPlayer.email,
    currentPlayer.x,
    currentPlayer.y,
    currentPlayer.map,
    'player:attacked',
    {
      email: currentPlayer.email,
      position: {
        x: currentPlayer.x,
        y: currentPlayer.y
      },
      direction: currentPlayer.direction,
      damage
    }
  );
});


 // ------------------ Player Skill (SERVER AUTHORITATIVE) ------------------
socket.on('player:skill', (data) => {
  if (!currentPlayer) return;

  const { skillType, data: skillData } = data;

  broadcastToAOI(
    currentPlayer.email,
    currentPlayer.x,
    currentPlayer.y,
    currentPlayer.map,
    'player:skill',
    {
      email: currentPlayer.email,
      skillType,
      position: {
        x: currentPlayer.x,
        y: currentPlayer.y
      },
      direction: currentPlayer.direction,
      data: skillData
    }
  );
});


 socket.on('player:changeMap', (data) => {
  if (!currentPlayer) return;

  const { map, position } = data;
  const oldMap = currentPlayer.map;

  // ------------------ REMOVE FROM OLD MAP ------------------
  if (mapPlayers.has(oldMap)) {
    mapPlayers.get(oldMap).delete(currentPlayer.email);
    broadcastToMap(oldMap, 'player:left', currentPlayer.email);

    // 🔥 CLEAN UP MONSTERS IF MAP IS EMPTY
    cleanupMapIfEmpty(oldMap);
  }

  // ------------------ UPDATE PLAYER STATE ------------------
  currentPlayer.map = map;
  currentPlayer.x = position.x;
  currentPlayer.y = position.y;

  // ------------------ ADD TO NEW MAP ------------------
  if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
  mapPlayers.get(map).add(currentPlayer.email);

  // ------------------ ENSURE MONSTERS ------------------
  spawnMonsters(map);

  // Send all existing monsters in this map to THIS player
  const monstersInMap = mapMonsters.get(map) || new Set();
  for (const monsterId of monstersInMap) {
    const m = monsters.get(monsterId);
    if (m && m.hp > 0) {
      socket.emit('monster:spawn', {
        id: m.id,
        type: m.type,
        mapId: m.mapId,
        x: m.x,
        y: m.y,
        hp: m.hp,
        maxHp: m.maxHp,
        direction: m.direction,
        state: m.state,
        spawnX: m.spawnX,
        spawnY: m.spawnY,
        target: m.target
      });
    }
  }

  // ------------------ SEND NEARBY PLAYERS ------------------
  const nearby = getPlayersInAOI(
    currentPlayer.email,
    position.x,
    position.y,
    map
  );
  nearby.forEach(p => socket.emit('player:joined', p));

  // Notify others
  broadcastToAOI(
    currentPlayer.email,
    position.x,
    position.y,
    map,
    'player:joined',
    {
      email: currentPlayer.email,
      name: currentPlayer.name,
      character_class: currentPlayer.character_class,
      level: currentPlayer.level,
      position,
      direction: currentPlayer.direction,
      state: currentPlayer.state
    }
  );
});


// ------------------ DISCONNECT ------------------
socket.on('disconnect', () => {
  if (!currentPlayer) return;

  console.log(`Player ${currentPlayer.name} disconnected`);

  if (mapPlayers.has(currentPlayer.map)) {
    mapPlayers.get(currentPlayer.map).delete(currentPlayer.email);

    broadcastToAOI(
      currentPlayer.email,
      currentPlayer.x,
      currentPlayer.y,
      currentPlayer.map,
      'player:left',
      currentPlayer.email
    );

    // 🔥 CLEAN UP MONSTERS IF MAP IS EMPTY
    cleanupMapIfEmpty(currentPlayer.map);
  }

  players.delete(currentPlayer.email);
});
});


function handlePlayerDeath(player) {
  if (player.isDead) return;

  player.isDead = true;
  player.state = 'dead';

  const townMap = 'town_1';

  // remove from current map
  if (mapPlayers.has(player.map)) {
    mapPlayers.get(player.map).delete(player.email);
  }

  // move to town
  player.map = townMap;
  player.x = MAPS[townMap].spawnX;
  player.y = MAPS[townMap].spawnY;

  if (!mapPlayers.has(townMap)) {
    mapPlayers.set(townMap, new Set());
  }
  mapPlayers.get(townMap).add(player.email);

  io.to(player.socketId).emit('player:died', {
    map: townMap,
    x: player.x,
    y: player.y
  });

  // revive (scaled)
  setTimeout(() => {
    const stats = calculatePlayerStats(player);

    player.maxHp = stats.maxHp;
    player.hp = stats.maxHp;
    player.attack = stats.attack;
    player.isDead = false;
    player.state = 'idle';

    io.to(player.socketId).emit('player:revived', {
      hp: player.hp,
      maxHp: player.maxHp
    });
  }, 3000);
}



// Start server
server.listen(PORT, () => {
  console.log(`🎮 Multiplayer server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log(`🌍 AOI Radius: ${AOI_RADIUS} pixels`);
});
