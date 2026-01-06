// ================= SERVER SETUP =================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.get('/health', (_, res) => res.send('OK'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3001;
const AOI_RADIUS = 800; // pixels

// ================= MAP DEFINITIONS (SERVER AUTHORITATIVE) =================
const MAPS = {
  town_1: { id: 'town_1', spawnX: 1200, spawnY: 900, safeZone: true },
  monster_field_1: { id: 'monster_field_1', spawnX: 400, spawnY: 400, safeZone: false },
  pvp_arena: { 
    id: 'pvp_arena',
    spawnX: 500,
    spawnY: 500,
    safeZone: false,
    minLevel: 10 // only level 10+ players can enter
  }
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

function calculateDerivedStats(player) {
  const base = calculatePlayerStats(player);
  const vitBonus = (player.stats?.VIT || 1) - 1;
  const strBonus = (player.stats?.STR || 1) - 1;

  const maxHp = base.maxHp + vitBonus * 10;
  const attack = base.attack + strBonus * 2;
  const speed = 1 + ((player.stats?.AGI || 1) - 1) * 0.1;

  return { maxHp, attack, speed };
}

// ================= LEVEL UP & XP =================
function levelUpPlayer(player) {
  // Increase level
  player.level += 1;

  // Recalculate stats including equipment and derived stats
  recalcPlayerWithEquipment(player);

  // Heal player to full after level-up
  player.hp = player.maxHp;

  // Give stat points
  player.statPointsAvailable += 5;

  // Notify player client of level-up and updated stats
  io.to(player.socketId).emit('player:levelUp', {
    level: player.level,
    hp: player.hp,
    maxHp: player.maxHp,
    attack: player.attack,
    speed: player.speed,
    stats: player.stats,
    statPointsAvailable: player.statPointsAvailable
  });
}


function giveXp(player, xpAmount) {
  player.xp += xpAmount;

  let xpToLevel = player.level * 100;

  // Allow MULTIPLE level-ups
  while (player.xp >= xpToLevel) {
    player.xp -= xpToLevel;
    levelUpPlayer(player);
    xpToLevel = player.level * 100;
  }

  // Always sync XP to client (EXP BAR FIX)
  io.to(player.socketId).emit('player:xpUpdated', {
    xp: player.xp,
    level: player.level,
    xpToLevel
  });
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

// ------------------ REALTIME CHAT ------------------
const CHAT_COOLDOWN = 5000; // 5 seconds between messages per player

// ------------------ Socket.IO Events ------------------
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  let currentPlayer = null;

 // ------------------ PLAYER JOIN ------------------
socket.on('player:join', (data) => {
  const { email, name, character_class, level, xp, position, map, stats, stat_points } = data;

  // ================= REJOIN / RECONNECT GUARD =================
  if (players.has(email)) {
    currentPlayer = players.get(email);

    // Update socket & live data
    currentPlayer.socketId = socket.id;
    currentPlayer.x = position.x;
    currentPlayer.y = position.y;
    currentPlayer.map = map;
    currentPlayer.lastUpdate = Date.now();

    // Recalculate stats with equipment
    recalcPlayerWithEquipment(currentPlayer);

    // Ensure map registration
    if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
    mapPlayers.get(map).add(email);

    console.log(`🔁 Player ${email} rejoined map ${map} with XP ${currentPlayer.xp}`);

    // ------------------ RESYNC XP ------------------
    socket.emit('player:xpUpdated', {
      xp: currentPlayer.xp,
      level: currentPlayer.level,
      xpToLevel: currentPlayer.level * 100
    });

    // ------------------ RESYNC FULL STATS ------------------
    socket.emit('player:statsInitialized', {
      stats: currentPlayer.stats,
      statPointsAvailable: currentPlayer.statPointsAvailable,
      hp: currentPlayer.hp,
      maxHp: currentPlayer.maxHp,
      attack: currentPlayer.attack,
      speed: currentPlayer.speed
    });

    // ------------------ MONSTERS ------------------
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

    // ------------------ NEARBY PLAYERS ------------------
    const nearby = getPlayersInAOI(email, position.x, position.y, map);
    nearby.forEach(p => socket.emit('player:joined', p));

    return; // 🔥 IMPORTANT: STOP HERE
  }

  // ================= FIRST TIME JOIN =================
  const baseStats = calculatePlayerStats({ character_class, level });

  currentPlayer = {
    email,
    name,
    character_class,
    level,
    xp: xp ?? 0,
    x: position.x,
    y: position.y,
    direction: 'front',
    state: 'idle',
    map,
    socketId: socket.id,
    lastUpdate: Date.now(),
    hp: baseStats.maxHp,
    maxHp: baseStats.maxHp,
    attack: baseStats.attack,
    speed: 1, // default speed
    isDead: false,
    inventory: [],
    statPointsAvailable: 5,
    stats: { STR: 1, AGI: 1, VIT: 1, INT: 1, DEX: 1, LUCK: 1 },
    lastAttackTime: 0,
    equipment: {} // initialize equipment
  };

  players.set(email, currentPlayer);

  // Apply equipment bonuses
  recalcPlayerWithEquipment(currentPlayer, { preserveHpRatio: false });
  currentPlayer.hp = currentPlayer.maxHp; // ✅ ensure full HP on join

  // ------------------ MAP REGISTRATION ------------------
  if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
  mapPlayers.get(map).add(email);

  console.log(`🆕 Player ${name} joined map ${map}`);

  // ------------------ XP INIT ------------------
  socket.emit('player:xpUpdated', {
    xp: currentPlayer.xp,
    level: currentPlayer.level,
    xpToLevel: currentPlayer.level * 100
  });

  // ------------------ STATS INIT (FULL) ------------------
  socket.emit('player:statsInitialized', {
    stats: currentPlayer.stats,
    statPointsAvailable: currentPlayer.statPointsAvailable,
    hp: currentPlayer.hp,
    maxHp: currentPlayer.maxHp,
    attack: currentPlayer.attack,
    speed: currentPlayer.speed
  });

  // ------------------ MONSTERS ------------------
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

  // ------------------ NEARBY PLAYERS ------------------
  const nearby = getPlayersInAOI(email, position.x, position.y, map);
  nearby.forEach(p => socket.emit('player:joined', p));

  // Notify others
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

socket.on('player:sendChat', (data) => {
  if (!currentPlayer) return;
  const now = Date.now();
  const { message, type, targetEmail } = data;
  const msg = message?.trim();
  if (!msg || msg.length > 200) return; // optional max length

  // Initialize per-type cooldown
  if (!currentPlayer.lastChat) currentPlayer.lastChat = {};
  if (!currentPlayer.lastChat[type]) currentPlayer.lastChat[type] = 0;

  if (now - currentPlayer.lastChat[type] < CHAT_COOLDOWN) {
    socket.emit('chat:spamBlocked', {
      message: `You are sending ${type || 'map'} messages too quickly. Please wait a moment.`
    });
    return;
  }

  currentPlayer.lastChat[type] = now;

  let recipients = [];

  switch (type) {
    case 'private':
      if (!targetEmail) return;
      const target = players.get(targetEmail);
      if (!target || !target.socketId) return;
      // send to both sender and target
      recipients.push(target.socketId, currentPlayer.socketId);
      break;

    case 'global':
      // send to everyone online
      recipients = Array.from(players.values())
        .filter(p => p.socketId)
        .map(p => p.socketId);
      break;

    case 'town':
      // only allow if current map is a town (safeZone)
      if (!MAPS[currentPlayer.map]?.safeZone) {
        socket.emit('chat:error', { message: 'You are not in a town map.' });
        return;
      }
      recipients = Array.from(mapPlayers.get(currentPlayer.map) || [])
        .map(email => players.get(email))
        .filter(p => p?.socketId)
        .map(p => p.socketId);
      break;

    case 'map':
      // all players in current map
      recipients = Array.from(mapPlayers.get(currentPlayer.map) || [])
        .map(email => players.get(email))
        .filter(p => p?.socketId)
        .map(p => p.socketId);
      break;

    default:
      socket.emit('chat:error', { message: 'Invalid chat type.' });
      return;
  }

  // Broadcast message to recipients
  for (const socketId of recipients) {
    io.to(socketId).emit('chat:message', {
      from: currentPlayer.name,
      message: msg,
      type,
      timestamp: now,
      senderEmail: currentPlayer.email
    });
  }
});


socket.on('player:allocateStat', ({ stat, points }) => {
  if (!currentPlayer || currentPlayer.statPointsAvailable < points) return;
  if (!currentPlayer.stats.hasOwnProperty(stat)) return;

  // Allocate points
  currentPlayer.stats[stat] += points;
  currentPlayer.statPointsAvailable -= points;

  // Recalculate stats including equipment
  recalcPlayerWithEquipment(currentPlayer);

  // Keep current HP within max HP
  currentPlayer.hp = Math.min(currentPlayer.hp, currentPlayer.maxHp);

  // Send updated stats to client
  io.to(currentPlayer.socketId).emit('player:statsUpdated', {
    stats: currentPlayer.stats,
    statPointsAvailable: currentPlayer.statPointsAvailable,
    hp: currentPlayer.hp,
    maxHp: currentPlayer.maxHp,
    attack: currentPlayer.attack,
    speed: currentPlayer.speed
  });
});

// ------------------ PvP ATTACK ------------------
socket.on('player:pvpAttack', (data) => {
  if (!currentPlayer || currentPlayer.isDead) return;

  const { targetEmail } = data;
  const now = Date.now();
  const COOLDOWN = 1000; // 1 second per attack

  if (now - currentPlayer.lastAttackTime < COOLDOWN) return; // still on cooldown
  currentPlayer.lastAttackTime = now;

  const target = players.get(targetEmail);
  if (!target || target.isDead) return;

  // Only allow PvP in pvp_arena
  if (currentPlayer.map !== 'pvp_arena' || target.map !== 'pvp_arena') return;

  // ------------------ Calculate damage (server authoritative) ------------------
  const calculateDamage = (player) => {
    let dmg = player.attack; // already includes STR bonus from recalcPlayerWithEquipment
    // Critical hit based on LUCK
    if (Math.random() < (player.stats.LUCK || 0) * 0.05) {
      dmg *= 2;
    }
    return Math.round(dmg);
  };

  const damage = calculateDamage(currentPlayer);

  // Apply damage to target
  target.hp = Math.max(0, target.hp - damage);

  // Notify attacker
  io.to(currentPlayer.socketId).emit('player:attackResult', {
    target: targetEmail,
    damage,
    targetHp: target.hp
  });

  // Notify target
  io.to(target.socketId).emit('player:hpChanged', {
    hp: target.hp,
    maxHp: target.maxHp,
    damage,
    attacker: currentPlayer.email
  });

  // Notify nearby players (AOI)
  broadcastToAOI(currentPlayer.email, currentPlayer.x, currentPlayer.y, currentPlayer.map, 'player:pvpHit', {
    attacker: currentPlayer.email,
    target: targetEmail,
    damage
  });

  // ------------------ Check death & respawn ------------------
  if (target.hp <= 0) {
    handlePvPDeath(target);
  }
});





  // ------------------ PLAYER ATTACKS MONSTER ------------------
socket.on('monster:hit', (data) => {
  if (!currentPlayer || currentPlayer.isDead) return;

  const { monsterId, damage } = data;
  const monster = monsters.get(monsterId);
  if (!monster || monster.mapId !== currentPlayer.map || monster.hp <= 0) return;

  // ---- APPLY DAMAGE (SERVER AUTHORITATIVE) ----
  monster.hp = Math.max(0, monster.hp - damage);
  monster.lastHitBy = currentPlayer.email;

  // ---- BROADCAST HIT ----
  broadcastToMap(monster.mapId, 'monster:hit', {
    id: monsterId,
    mapId: monster.mapId,
    hp: monster.hp,
    damage
  });

  // ------------------ MONSTER DEAD ------------------
  if (monster.hp <= 0) {
    broadcastToMap(monster.mapId, 'monster:despawn', {
      id: monsterId,
      mapId: monster.mapId
    });

    const killer = players.get(monster.lastHitBy);
    if (killer) {
      const stats = MONSTER_STATS[monster.type];

      // ---------- GIVE XP ----------
      giveXp(killer, stats.xp);

      // ---------- GIVE BCOINS ----------
      const bcoinsAmount = Math.floor(Math.random() * 21) + 10; // 10–30

      // ---------- GIVE LOOT ----------
      const lootItem = stats.loot[Math.floor(Math.random() * stats.loot.length)];
      killer.inventory.push(lootItem);

      // ---------- SPAWN DROP ----------
      const dropId = `drop_${Date.now()}_${Math.random()}`;
      const drop = {
        id: dropId,
        x: monster.x,
        y: monster.y,
        type: Math.random() > 0.3 ? 'bcoins' : 'item',
        amount: bcoinsAmount,
        itemName: lootItem,
        mapId: monster.mapId
      };

      broadcastToMap(monster.mapId, 'drop:spawn', drop);

      // ---------- NOTIFY KILLER (EXP BAR FIX) ----------
      io.to(killer.socketId).emit('monster:killed', {
        monsterId,
        xp: stats.xp,
        currentXp: killer.xp,
        level: killer.level,
        bcoins: bcoinsAmount,
        loot: {
          id: lootItem,
          name: lootItem
        }
      });
    }

    // ---------- SAFE RESPAWN ----------
    setTimeout(() => {
      if (!monsters.has(monsterId)) return;

      monster.hp = monster.maxHp;
      monster.x = monster.spawnX;
      monster.y = monster.spawnY;
      monster.state = 'idle';
      monster.target = null;

      broadcastToMap(monster.mapId, 'monster:spawn', {
        id: monster.id,
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
  const attacker = attackerEmail ? players.get(attackerEmail) : null;

  // PvP enforcement: allow only in PvP maps
  if (attacker && currentPlayer.map !== 'pvp_arena') {
    // Ignore PvP damage outside PvP map
    io.to(currentPlayer.socketId).emit('player:hitDenied', {
      message: 'You cannot attack other players outside the PvP arena.'
    });
    return;
  }

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
    // PvP death logic: respawn in PvP arena at spawn point
    if (currentPlayer.map === 'pvp_arena') {
      currentPlayer.hp = currentPlayer.maxHp;
      currentPlayer.x = MAPS.pvp_arena.spawnX;
      currentPlayer.y = MAPS.pvp_arena.spawnY;

      io.to(currentPlayer.socketId).emit('player:revived', {
        hp: currentPlayer.hp,
        maxHp: currentPlayer.maxHp,
        map: 'pvp_arena',
        x: currentPlayer.x,
        y: currentPlayer.y
      });
    } else {
      // Normal death handling
      handlePlayerDeath(currentPlayer);
    }
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

// ------------------ DROP PICKUP ------------------
socket.on('drop:pickup', ({ dropId }) => {
  if (!currentPlayer) return;

  broadcastToMap(currentPlayer.map, 'drop:pickup', { dropId });
});


  // ------------------ CHANGE MAP ------------------
socket.on('player:changeMap', (data) => {
  if (!currentPlayer) return;
  const { map, position } = data;
  const oldMap = currentPlayer.map;

  // Check if map exists
  const targetMap = MAPS[map];
  if (!targetMap) {
    io.to(currentPlayer.socketId).emit('player:mapError', { message: 'Map does not exist.' });
    return;
  }

  // Enforce minLevel if defined
  if (targetMap.minLevel && currentPlayer.level < targetMap.minLevel) {
    io.to(currentPlayer.socketId).emit('player:mapError', { 
      message: `You need to be level ${targetMap.minLevel}+ to enter this map.` 
    });
    return;
  }

  // Remove from old map
  if (mapPlayers.has(oldMap)) {
    mapPlayers.get(oldMap).delete(currentPlayer.email);
    broadcastToMap(oldMap, 'player:left', currentPlayer.email);
    cleanupMapIfEmpty(oldMap);
  }

  // Update current player
  currentPlayer.map = map;
  currentPlayer.x = position.x;
  currentPlayer.y = position.y;

  if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
  mapPlayers.get(map).add(currentPlayer.email);

  // Spawn monsters if applicable
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

  // Notify nearby players
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
socket.on('disconnect', async () => {
  if (!currentPlayer) return;

  console.log(`Player ${currentPlayer.name} disconnected`);

  // Remove from map presence (this is correct)
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

  // IMPORTANT: do NOT delete the player
  // Keep server state authoritative
  currentPlayer.socketId = null;
  currentPlayer.isOnline = false;

  // OPTIONAL BUT RECOMMENDED: save authoritative state
  try {
    await savePlayerStats(currentPlayer);
  } catch (err) {
    console.error('Failed to save player on disconnect', err);
  }
});



async function savePlayerStats(player) {
  await base44.entities.PlayerProfile.update(player.profileId, {
    str: player.stats.STR,
    agi: player.stats.AGI,
    vit: player.stats.VIT,
    int: player.stats.INT,
    dex: player.stats.DEX,
    luck: player.stats.LUCK,
    stat_points: player.statPointsAvailable
  });
}

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

  // Revive after 3 seconds with stats including equipment
  setTimeout(() => {
    recalcPlayerWithEquipment(player); // ✅ include equipment bonuses
    player.hp = player.maxHp;          // heal to full
    player.state = 'idle';
    player.isDead = false;

    io.to(player.socketId).emit('player:revived', {
      hp: player.hp,
      maxHp: player.maxHp,
      attack: player.attack,
      speed: player.speed
    });
  }, 3000);
}

function handlePvPDeath(player) {
  if (player.isDead) return;

  player.isDead = true;
  player.state = 'dead';

  // Short respawn timer (3 seconds)
  setTimeout(() => {
    recalcPlayerWithEquipment(player); // ✅ include equipment bonuses
    player.hp = player.maxHp;          // heal to full
    player.state = 'idle';
    player.isDead = false;

    // Respawn at PvP spawn
    player.x = MAPS.pvp_arena.spawnX;
    player.y = MAPS.pvp_arena.spawnY;

    io.to(player.socketId).emit('player:revived', {
      hp: player.hp,
      maxHp: player.maxHp,
      attack: player.attack,
      speed: player.speed,
      x: player.x,
      y: player.y
    });
  }, 3000);
}

function recalcPlayerWithEquipment(player, options = {}) {
  if (!player) return;

  const preserveHpRatio = options.preserveHpRatio ?? true; // default: true

  // ------------------ CALCULATE BASE DERIVED STATS ------------------
  const base = calculateDerivedStats(player);

  // ------------------ APPLY EQUIPMENT BONUSES ------------------
  const bonus = {};
  if (player.equipment) {
    for (const item of Object.values(player.equipment)) {
      if (!item) continue;
      for (const [statKey, value] of Object.entries(item)) {
        if (typeof value === 'number') {
          bonus[statKey] = (bonus[statKey] || 0) + value;
        }
      }
    }
  }

  // ------------------ APPLY BASE + EQUIPMENT ------------------
  for (const [statKey, baseValue] of Object.entries(base)) {
    player[statKey] = (baseValue || 0) + (bonus[statKey] || 0);
  }

  // Apply any equipment-only stats not in base
  for (const [statKey, value] of Object.entries(bonus)) {
    if (!(statKey in base)) {
      player[statKey] = value;
    }
  }

  // ------------------ RESTORE HP RATIO ------------------
  if (preserveHpRatio) {
    // Only preserve ratio if player is alive
    if (!player.isDead) {
      const oldHp = player.hp ?? player.maxHp;
      const oldMaxHp = player.maxHp ?? oldHp;
      const hpRatio = oldHp / oldMaxHp;
      player.hp = Math.round(player.maxHp * hpRatio);
      if (player.hp > player.maxHp) player.hp = player.maxHp;
    }
  } else {
    // full heal if not preserving ratio (e.g., respawn)
    player.hp = player.maxHp;
  }

  // ------------------ ENSURE STATS EXIST ------------------
  if (!player.stats) player.stats = {};
  for (const statKey of Object.keys(player.stats)) {
    player.stats[statKey] = player.stats[statKey]; // preserve allocations
  }
}


});

// Start server
server.listen(PORT, () => {
  console.log(`🎮 Multiplayer server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log(`🌍 AOI Radius: ${AOI_RADIUS} pixels`);
});
