// ================= SERVER SETUP =================
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

// ================= MAP DEFINITIONS (SERVER AUTHORITATIVE) =================
const MAPS = {
  town_1: { id: 'town_1', spawnX: 1200, spawnY: 900, safeZone: true },
  monster_field_1: { id: 'monster_field_1', spawnX: 400, spawnY: 400, safeZone: false }
};

// ================= PLAYER STAT SCALING (MMORPG FORMULA) =================
function calculatePlayerStats(player) {
  const { character_class, level } = player;

  const CLASS_BASE = {
    assassin: { baseHp: 120, hpPerLevel: 25, baseAttack: 15, attackPerLevel: 4 }
    // add more classes later
  };

  const cls = CLASS_BASE[character_class] || CLASS_BASE.assassin;

  const maxHp = cls.baseHp + cls.hpPerLevel * (level - 1);
  const attack = cls.baseAttack + cls.attackPerLevel * (level - 1);

  return { maxHp, attack };
}

// ================= LEVEL UP & XP =================
function levelUpPlayer(player) {
  player.level += 1;
  const stats = calculatePlayerStats(player);
  player.maxHp = stats.maxHp;
  player.hp = stats.maxHp; // heal to full on level-up
  player.attack = stats.attack;

  // Notify player client
  io.to(player.socketId).emit('player:levelUp', {
    level: player.level,
    hp: player.hp,
    maxHp: player.maxHp,
    attack: player.attack
  });
}

function giveXp(player, xpAmount) {
  player.xp += xpAmount;
  const xpToLevel = player.level * 100; // example formula: 100 XP per level
  if (player.xp >= xpToLevel) {
    player.xp -= xpToLevel;
    levelUpPlayer(player);
  }
}

// ================= PLAYER & MAP DATA =================
const players = new Map();      // email -> player object
const mapPlayers = new Map();   // mapId -> Set of emails

// ================= MONSTER DATA =================
const monsters = new Map();     // monsterId -> monster object
const mapMonsters = new Map();  // mapId -> Set of monsterIds

// ================= MONSTER CONFIG =================
const MONSTER_SPAWNS = {
  monster_field_1: {
    count: 20,
    types: ['poring', 'lunatic', 'fabre', 'chonchon'],
    bounds: { minX: 100, maxX: 2300, minY: 100, maxY: 1800 }
  }
};

const MONSTER_STATS = {
  poring:   { hp: 50, attack: 5, speed: 1.5, aggro: 150, attackRange: 40, cooldown: 1500, xp: 5, loot: ['potion'] },
  lunatic:  { hp: 60, attack: 8, speed: 2,   aggro: 180, attackRange: 50, cooldown: 1300, xp: 8, loot: ['potion','coin'] },
  fabre:    { hp: 45, attack: 6, speed: 1.8, aggro: 160, attackRange: 45, cooldown: 1400, xp: 6, loot: ['coin'] },
  chonchon: { hp: 55, attack: 7, speed: 2.2, aggro: 200, attackRange: 60, cooldown: 1200, xp: 10, loot: ['potion','coin','gem'] }
};

// ================= HELPER FUNCTIONS =================
function getDistance(x1, y1, x2, y2) {
  return Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
}

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

function broadcastToMap(mapId, event, data) {
  const playersInMap = mapPlayers.get(mapId) || new Set();
  for (const email of playersInMap) {
    const p = players.get(email);
    if (p?.socketId) io.to(p.socketId).emit(event, data);
  }
}

function cleanupMapIfEmpty(mapId) {
  const playersInMap = mapPlayers.get(mapId);
  if (playersInMap && playersInMap.size === 0) {
    const monsterSet = mapMonsters.get(mapId);
    if (monsterSet) {
      for (const monsterId of monsterSet) monsters.delete(monsterId);
      mapMonsters.delete(mapId);
    }
    console.log(`🧹 Cleared monsters for empty map ${mapId}`);
  }
}



// ================= MONSTER FUNCTIONS =================
function spawnMonsters(mapId) {
  const config = MONSTER_SPAWNS[mapId];
  if (!config) return;
  if (!mapMonsters.has(mapId)) mapMonsters.set(mapId, new Set());
  const monsterSet = mapMonsters.get(mapId);
  if (monsterSet.size >= config.count) return;

  for (let i = monsterSet.size; i < config.count; i++) {
    const type = config.types[Math.floor(Math.random() * config.types.length)];
    const stats = MONSTER_STATS[type];
    const monsterId = `${mapId}_${type}_${Date.now()}_${i}`;
    const x = config.bounds.minX + Math.random() * (config.bounds.maxX - config.bounds.minX);
    const y = config.bounds.minY + Math.random() * (config.bounds.maxY - config.bounds.minY);

    const monster = {
      id: monsterId,
      type,
      mapId,
      x, y, spawnX: x, spawnY: y,
      direction: 'front', state: 'idle',
      hp: stats.hp, maxHp: stats.hp,
      attack: stats.attack, speed: stats.speed,
      aggroRange: stats.aggro,
      attackRange: stats.attackRange,
      attackCooldown: stats.cooldown,
      lastAttack: 0,
      target: null,
      lastUpdate: Date.now()
    };

    monsters.set(monsterId, monster);
    monsterSet.add(monsterId);

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


// ------------------ MONSTER ATTACK PLAYER ------------------
// Call this in your monster AI attack logic
function monsterAttackPlayer(monster, targetPlayer) {
  if (!targetPlayer || targetPlayer.isDead) return;

  // Apply damage
  const damage = monster.attack;
  targetPlayer.hp = Math.max(0, targetPlayer.hp - damage);

  // Notify the target
  io.to(targetPlayer.socketId).emit('player:hpChanged', {
    hp: targetPlayer.hp,
    maxHp: targetPlayer.maxHp,
    damage,
    attacker: monster.id
  });

  // Broadcast to AOI
  broadcastToAOI(
    targetPlayer.email,
    targetPlayer.x,
    targetPlayer.y,
    targetPlayer.map,
    'player:damaged',
    {
      email: targetPlayer.email,
      damage,
      attacker: monster.id
    }
  );

  // Trigger death if HP depleted
  if (targetPlayer.hp <= 0) {
    handlePlayerDeath(targetPlayer);
  }
}

function updateMonsterAI() {
  const now = Date.now();
  for (const [monsterId, monster] of monsters.entries()) {
    if (monster.hp <= 0) continue;

    const playersInMap = mapPlayers.get(monster.mapId);
    if (!playersInMap || playersInMap.size === 0) continue;

    let closestPlayer = null;
    let closestDist = Infinity;

    // Find closest player within aggro range
    for (const email of playersInMap) {
      const p = players.get(email);
      if (!p || p.isDead) continue;
      const dist = getDistance(monster.x, monster.y, p.x, p.y);
      if (dist < closestDist && dist < monster.aggroRange) {
        closestDist = dist;
        closestPlayer = p;
      }
    }

    if (closestPlayer) {
      monster.target = closestPlayer.email;

      if (closestDist > monster.attackRange) {
        // -------------------- CHASE --------------------
        const angle = Math.atan2(closestPlayer.y - monster.y, closestPlayer.x - monster.x);
        monster.x += Math.cos(angle) * monster.speed;
        monster.y += Math.sin(angle) * monster.speed;
        monster.direction = Math.abs(Math.cos(angle)) > Math.abs(Math.sin(angle))
          ? (Math.cos(angle) > 0 ? 'right' : 'left')
          : (Math.sin(angle) > 0 ? 'front' : 'back');
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
      } else {
        // -------------------- ATTACK --------------------
        if (now - monster.lastAttack > monster.attackCooldown) {
          monster.state = 'attacking';
          monster.lastAttack = now;

          // Broadcast attack animation
          broadcastToMap(monster.mapId, 'monster:attack', {
            id: monsterId,
            mapId: monster.mapId,
            targetEmail: closestPlayer.email,
            damage: monster.attack,
            x: monster.x,
            y: monster.y,
            direction: monster.direction
          });

          // Deal damage to player & auto-death check
          monsterAttackPlayer(monster, closestPlayer);

          setTimeout(() => {
            if (monster.hp > 0) monster.state = 'idle';
          }, 400);
        }
      }
    } else {
      // -------------------- IDLE / WANDER --------------------
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

  // ------------------ PLAYER JOIN ------------------
  socket.on('player:join', (data) => {
    const { email, name, character_class, level, position, map } = data;

    // Calculate dynamic stats (MMORPG-style)
    const stats = calculatePlayerStats({ character_class, level });

    currentPlayer = {
      email,
      name,
      character_class,
      level,
      x: position.x,
      y: position.y,
      direction: 'front',
      state: 'idle',
      map,
      socketId: socket.id,
      lastUpdate: Date.now(),
      hp: stats.maxHp,
      maxHp: stats.maxHp,
      attack: stats.attack,
      isDead: false,
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


  // ------------------ PLAYER ATTACKS MONSTER ------------------
socket.on('monster:hit', (data) => {
  if (!currentPlayer || currentPlayer.isDead) return;
  const { monsterId, damage } = data;
  const monster = monsters.get(monsterId);
  if (!monster || monster.mapId !== currentPlayer.map) return;

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

  if (monster.hp <= 0) {
    // Monster defeated
    broadcastToMap(monster.mapId, 'monster:despawn', { id: monsterId, mapId: monster.mapId });

    const killer = players.get(monster.lastHitBy);
    if (killer) {
      const stats = MONSTER_STATS[monster.type];

      // ---- GIVE XP AND HANDLE LEVEL-UP ----
      giveXp(killer, stats.xp);

      // Give loot
      const lootItem = stats.loot[Math.floor(Math.random() * stats.loot.length)];
      killer.inventory.push(lootItem);

      // Notify player of kill and loot
      io.to(killer.socketId).emit('monster:killed', { monsterId, loot: lootItem });
    }

    // Safe respawn of monster
    setTimeout(() => {
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
  }
});




// ------------------ PLAYER MOVEMENT ------------------
  socket.on('player:move', (data) => {
    if (!currentPlayer || currentPlayer.isDead) return;
    const { position, direction, state } = data;
    const now = Date.now();
    if (now - currentPlayer.lastUpdate < 40) return;

    currentPlayer.x = position.x;
    currentPlayer.y = position.y;
    currentPlayer.direction = direction;
    currentPlayer.state = state;
    currentPlayer.lastUpdate = now;
  });

  // ------------------ PLAYER ATTACK ------------------
  socket.on('player:attack', (data) => {
    if (!currentPlayer || currentPlayer.isDead) return;
    const { damage } = data;
    broadcastToAOI(
      currentPlayer.email,
      currentPlayer.x,
      currentPlayer.y,
      currentPlayer.map,
      'player:attacked',
      {
        email: currentPlayer.email,
        position: { x: currentPlayer.x, y: currentPlayer.y },
        direction: currentPlayer.direction,
        damage
      }
    );
  });

// ------------------ PLAYER GETS HIT ------------------
socket.on('player:hit', (data) => {
  if (!currentPlayer || currentPlayer.isDead) return;

  const { damage, attackerEmail } = data; // attackerEmail can be player or monster

  // Reduce HP safely
  currentPlayer.hp = Math.max(0, currentPlayer.hp - damage);

  // Notify this player of damage
  io.to(currentPlayer.socketId).emit('player:hpChanged', {
    hp: currentPlayer.hp,
    maxHp: currentPlayer.maxHp,
    damage,
    attacker: attackerEmail || null
  });

  // Broadcast to nearby players so they can show hit effect
  broadcastToAOI(
    currentPlayer.email,
    currentPlayer.x,
    currentPlayer.y,
    currentPlayer.map,
    'player:damaged',
    {
      email: currentPlayer.email,
      damage,
      attacker: attackerEmail || null
    }
  );

  // Check for death
  if (currentPlayer.hp <= 0) {
    handlePlayerDeath(currentPlayer);
  }
});


  // ------------------ PLAYER SKILL ------------------
  socket.on('player:skill', (data) => {
    if (!currentPlayer || currentPlayer.isDead) return;
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
        position: { x: currentPlayer.x, y: currentPlayer.y },
        direction: currentPlayer.direction,
        data: skillData
      }
    );
  });

  // ------------------ CHANGE MAP ------------------
  socket.on('player:changeMap', (data) => {
    if (!currentPlayer) return;
    const { map, position } = data;
    const oldMap = currentPlayer.map;

    if (mapPlayers.has(oldMap)) {
      mapPlayers.get(oldMap).delete(currentPlayer.email);
      broadcastToMap(oldMap, 'player:left', currentPlayer.email);
      cleanupMapIfEmpty(oldMap);
    }

    currentPlayer.map = map;
    currentPlayer.x = position.x;
    currentPlayer.y = position.y;

    if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
    mapPlayers.get(map).add(currentPlayer.email);

    spawnMonsters(map);

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

    const nearby = getPlayersInAOI(currentPlayer.email, position.x, position.y, map);
    nearby.forEach(p => socket.emit('player:joined', p));

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
      cleanupMapIfEmpty(currentPlayer.map);
    }

    players.delete(currentPlayer.email);
  });
});

// ------------------ PLAYER DEATH HANDLER ------------------
function handlePlayerDeath(player) {
  if (player.isDead) return;

  player.isDead = true;
  player.state = 'dead';

  const townMap = 'town_1';

  // Remove from current map
  if (mapPlayers.has(player.map)) {
    mapPlayers.get(player.map).delete(player.email);
  }

  // Move to town
  player.map = townMap;
  player.x = MAPS[townMap].spawnX;
  player.y = MAPS[townMap].spawnY;

  if (!mapPlayers.has(townMap)) mapPlayers.set(townMap, new Set());
  mapPlayers.get(townMap).add(player.email);

  io.to(player.socketId).emit('player:died', {
    map: townMap,
    x: player.x,
    y: player.y
  });

  // Revive after 3 seconds with scaled stats
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
