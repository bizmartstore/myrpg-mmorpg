/*
 * ETERNAL QUEST - MULTIPLAYER SERVER
 *
 * Full ready-to-run server.js with XP & Loot system
 *
 * Setup:
 * 1. Save this as server.js in your project root
 * 2. Run: npm install express socket.io cors
 * 3. Start server: node server.js
 * 4. Add to .env: REACT_APP_SOCKET_URL=http://localhost:3001
 * 5. Test your game client with multiple tabs
 */

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
const mapMonstersSpawned = new Map(); // mapId -> boolean (spawned flag)

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

// Spawn monsters
function spawnMonsters(mapId) {
  if (mapMonstersSpawned.get(mapId)) return;
  mapMonstersSpawned.set(mapId, true);

  const config = MONSTER_SPAWNS[mapId];
  if (!config) return;
  if (!mapMonsters.has(mapId)) mapMonsters.set(mapId, new Set());

  for (let i = 0; i < config.count; i++) {
    const type = config.types[Math.floor(Math.random() * config.types.length)];
    const stats = MONSTER_STATS[type];
    const monsterId = `${mapId}_${type}_${i}`;
    const monster = {
      id: monsterId,
      type,
      mapId,
      x: config.bounds.minX + Math.random() * (config.bounds.maxX - config.bounds.minX),
      y: config.bounds.minY + Math.random() * (config.bounds.maxY - config.bounds.minY),
      spawnX: 0,
      spawnY: 0,
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
    monster.spawnX = monster.x;
    monster.spawnY = monster.y;
    monsters.set(monsterId, monster);
    mapMonsters.get(mapId).add(monsterId);

    broadcastToMap(mapId, 'monster:spawn', {
      id: monsterId,
      type,
      x: monster.x,
      y: monster.y,
      hp: monster.hp,
      maxHp: monster.maxHp
    });
  }

  console.log(`✅ Spawned ${config.count} monsters for map ${mapId}`);
}

// ------------------ Monster AI ------------------
function updateMonsterAI() {
  const now = Date.now();
  for (const [monsterId, monster] of monsters.entries()) {
    if (monster.hp <= 0) continue;
    const playersInMap = mapPlayers.get(monster.mapId) || new Set();

    let closestPlayer = null;
    let closestDist = Infinity;
    for (const email of playersInMap) {
      const p = players.get(email);
      if (!p) continue;
      const dist = getDistance(monster.x, monster.y, p.x, p.y);
      if (dist < closestDist && dist < monster.aggroRange) {
        closestDist = dist;
        closestPlayer = p;
      }
    }

    if (closestPlayer && closestDist < monster.aggroRange) {
      monster.target = closestPlayer.email;

      if (closestDist > monster.attackRange) {
        const angle = Math.atan2(closestPlayer.y - monster.y, closestPlayer.x - monster.x);
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
            x: monster.x,
            y: monster.y,
            direction: monster.direction,
            state: monster.state
          });
          monster.lastUpdate = now;
        }
      } else {
        if (now - monster.lastAttack > monster.attackCooldown) {
          monster.state = 'attacking';
          monster.lastAttack = now;
          broadcastToMap(monster.mapId, 'monster:attack', {
            id: monsterId,
            targetEmail: closestPlayer.email,
            damage: monster.attack,
            x: monster.x,
            y: monster.y,
            direction: monster.direction
          });
          setTimeout(() => { monster.state = 'idle'; }, 400);
        }
      }
    } else {
      monster.target = null;
      monster.state = 'idle';
      if (Math.random() > 0.99 && now - monster.lastUpdate > 500) {
        const angle = Math.random() * Math.PI * 2;
        monster.x += Math.cos(angle) * 10;
        monster.y += Math.sin(angle) * 10;
        broadcastToMap(monster.mapId, 'monster:move', {
          id: monsterId,
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

// ------------------ Player & Monster Broadcast ------------------
setInterval(() => {
  for (const [email, player] of players.entries()) {
    if (!player.socketId) continue;
    broadcastToAOI(email, player.x, player.y, player.map, 'player:moved', {
      email: player.email,
      name: player.name,
      character_class: player.character_class,
      position: { x: player.x, y: player.y },
      direction: player.direction,
      state: player.state,
      timestamp: Date.now()
    });
  }
}, 50);

setInterval(() => {
  for (const [monsterId, monster] of monsters.entries()) {
    if (monster.hp <= 0) continue;
    broadcastToMap(monster.mapId, 'monster:update', {
      id: monsterId,
      type: monster.type,
      x: monster.x,
      y: monster.y,
      direction: monster.direction,
      state: monster.state,
      hp: monster.hp,
      maxHp: monster.maxHp,
      spawnX: monster.spawnX,
      spawnY: monster.spawnY,
      target: monster.target
    });
  }
}, 50);

// ------------------ Socket.IO Events ------------------
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  let currentPlayer = null;

  socket.on('player:join', (data) => {
    const { email, name, character_class, level, position, map } = data;
    currentPlayer = { email, name, character_class, level, x: position.x, y: position.y, direction: 'front', state: 'idle', map, socketId: socket.id, lastUpdate: Date.now(), xp: 0, inventory: [] };
    players.set(email, currentPlayer);

    if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
    mapPlayers.get(map).add(email);

    console.log(`Player ${name} joined map ${map}`);

    spawnMonsters(map);

    // Send existing monsters
    const monstersInMap = mapMonsters.get(map) || new Set();
    for (const monsterId of monstersInMap) {
      const m = monsters.get(monsterId);
      if (m && m.hp > 0) {
        socket.emit('monster:spawn', { 
          id: m.id,
          type: m.type,
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

    const nearby = getPlayersInAOI(email, position.x, position.y, map);
    nearby.forEach(p => socket.emit('player:joined', p));

    broadcastToAOI(email, position.x, position.y, map, 'player:joined', { 
      email, name, character_class, level, position, direction: 'front', state: 'idle' 
    });
  });

  // ------------------ Player Attacks Monster ------------------
  socket.on('monster:hit', (data) => {
    if (!currentPlayer) return;
    const { monsterId, damage } = data;
    const monster = monsters.get(monsterId);
    if (!monster) return;

    monster.hp = Math.max(0, monster.hp - damage);
    monster.lastHitBy = currentPlayer.email; // Track killer

    broadcastToMap(monster.mapId, 'monster:hit', { id: monsterId, hp: monster.hp, damage });

    if (monster.hp <= 0) {
      // Monster defeated
      broadcastToMap(monster.mapId, 'monster:despawn', { id: monsterId });

      const killer = players.get(monster.lastHitBy);
      if (killer) {
        const stats = MONSTER_STATS[monster.type];
        // Award XP
        killer.xp += stats.xp;
        // Award Loot (random from loot array)
        const lootItem = stats.loot[Math.floor(Math.random() * stats.loot.length)];
        killer.inventory.push(lootItem);

        io.to(killer.socketId).emit('monster:killed', { monsterId, xp: stats.xp, loot: lootItem });
      }

      setTimeout(() => {
        // Respawn monster
        monster.hp = monster.maxHp;
        monster.x = monster.spawnX;
        monster.y = monster.spawnY;
        monster.state = 'idle';
        monster.target = null;
        broadcastToMap(monster.mapId, 'monster:spawn', { id: monsterId, type: monster.type, x: monster.x, y: monster.y, hp: monster.hp, maxHp: monster.maxHp });
      }, 5000);
    }
  });

  // ------------------ Other Player Events ------------------
  socket.on('player:move', (data) => {
    if (!currentPlayer) return;
    const { position, direction, state, map } = data;
    const now = Date.now();

    if (now - currentPlayer.lastUpdate < 40) return;
    const oldMap = currentPlayer.map;

    currentPlayer.x = position.x;
    currentPlayer.y = position.y;
    currentPlayer.direction = direction;
    currentPlayer.state = state;
    currentPlayer.map = map;
    currentPlayer.lastUpdate = now;

    if (oldMap !== map) {
      if (mapPlayers.has(oldMap)) mapPlayers.get(oldMap).delete(currentPlayer.email);
      broadcastToMap(oldMap, 'player:left', currentPlayer.email);

      if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
      mapPlayers.get(map).add(currentPlayer.email);

      const nearby = getPlayersInAOI(currentPlayer.email, position.x, position.y, map);
      nearby.forEach(p => socket.emit('player:joined', p));

      broadcastToAOI(currentPlayer.email, position.x, position.y, map, 'player:joined', {
        email: currentPlayer.email,
        name: currentPlayer.name,
        character_class: currentPlayer.character_class,
        level: currentPlayer.level,
        position,
        direction,
        state
      });
    } else {
      broadcastToAOI(currentPlayer.email, position.x, position.y, map, 'player:moved', {
        email: currentPlayer.email,
        position,
        direction,
        state
      });
    }
  });

  socket.on('player:attack', (data) => {
    if (!currentPlayer) return;
    const { position, direction, damage } = data;
    broadcastToAOI(currentPlayer.email, position.x, position.y, currentPlayer.map, 'player:attacked', { email: currentPlayer.email, position, direction, damage });
  });

  socket.on('player:skill', (data) => {
    if (!currentPlayer) return;
    const { skillType, position, direction, data: skillData } = data;
    broadcastToAOI(currentPlayer.email, position.x, position.y, currentPlayer.map, 'player:skill', { email: currentPlayer.email, skillType, position, direction, data: skillData });
  });

 socket.on('player:changeMap', (data) => {
  if (!currentPlayer) return;
  const { map, position } = data;
  const oldMap = currentPlayer.map;

  // Remove from old map
  if (mapPlayers.has(oldMap)) mapPlayers.get(oldMap).delete(currentPlayer.email);
  broadcastToMap(oldMap, 'player:left', currentPlayer.email);

  // Update player state
  currentPlayer.map = map;
  currentPlayer.x = position.x;
  currentPlayer.y = position.y;

  // Add to new map
  if (!mapPlayers.has(map)) mapPlayers.set(map, new Set());
  mapPlayers.get(map).add(currentPlayer.email);

  // 🔥🔥🔥 FIX START 🔥🔥🔥

  // Ensure monsters exist for this map
  spawnMonsters(map);

  // Send all existing monsters in this map to THIS player
  const monstersInMap = mapMonsters.get(map) || new Set();
  for (const monsterId of monstersInMap) {
    const m = monsters.get(monsterId);
    if (m && m.hp > 0) {
      socket.emit('monster:spawn', {
        id: m.id,
        type: m.type,
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

  // 🔥🔥🔥 FIX END 🔥🔥🔥

  // Send nearby players
  const nearby = getPlayersInAOI(currentPlayer.email, position.x, position.y, map);
  nearby.forEach(p => socket.emit('player:joined', p));

  // Notify others
  broadcastToAOI(currentPlayer.email, position.x, position.y, map, 'player:joined', {
    email: currentPlayer.email,
    name: currentPlayer.name,
    character_class: currentPlayer.character_class,
    level: currentPlayer.level,
    position,
    direction: currentPlayer.direction,
    state: currentPlayer.state
  });
});


  socket.on('disconnect', () => {
    if (!currentPlayer) return;
    console.log(`Player ${currentPlayer.name} disconnected`);
    if (mapPlayers.has(currentPlayer.map)) mapPlayers.get(currentPlayer.map).delete(currentPlayer.email);
    broadcastToAOI(currentPlayer.email, currentPlayer.x, currentPlayer.y, currentPlayer.map, 'player:left', currentPlayer.email);
    players.delete(currentPlayer.email);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🎮 Multiplayer server running on port ${PORT}`);
  console.log(`📡 Socket.IO ready for connections`);
  console.log(`🌍 AOI Radius: ${AOI_RADIUS} pixels`);
});
