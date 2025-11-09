// =======================
// server.js
// =======================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

// =======================
// Environment Variables
// =======================
// PORT is automatically assigned by Render
const PORT = process.env.PORT || 3000;

// Optional: Store Google service account JSON in ENV for security
// Example: process.env.GOOGLE_CREDENTIALS
const credentials = process.env.GOOGLE_CREDENTIALS
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS)
  : JSON.parse(fs.readFileSync(path.join(__dirname, "credentials.json")));

// =======================
// Google Sheets Setup
// =======================
const SHEET_ID = "1U3MFNEf7G32Gs10Z0s0NoiZ6PPP1TgsEVbRUFcmjr7Y";
const SHEET_RANGE = "PlayerData!A2:Z";

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
});

const sheets = google.sheets({ version: "v4", auth });

// =======================
// Express + Socket.IO
// =======================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }, // allow all origins
});

// Serve client files from /public
app.use(express.static(path.join(__dirname, "public")));

// =======================
// Game State
// =======================
let players = {}; // { socketId: {x, y, dir, attacking, images} }
let monsters = {}; // future monsters

// =======================
// Utility: Get Player Data from Google Sheets
// =======================
async function getPlayerDataByEmail(email) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_RANGE,
    });

    const rows = res.data.values;
    if (!rows?.length) return null;

    const keys = [
      "Email","PlayerName","CharacterID","CharacterName","CharacterClass","PositionX","PositionY","MovementAnimation","MapID",
      "CurrentHP","MaxHP","CurrentMana","MaxMana","Attack","Defense","Speed","CritDamage","CurrentEXP","MaxEXP","Level",
      "StatPointsAvailable","LevelUpsPending","Skill1_Name","Skill1_Damage","Skill1_Cooldown","Skill1_Image","Skill1_Range","Skill1_AnimationURL",
      "Skill2_Name","Skill2_Damage","Skill2_Cooldown","Skill2_Image","Skill2_Range","Skill2_AnimationURL",
      "Skill3_Name","Skill3_Damage","Skill3_Cooldown","Skill3_Image","Skill3_Range","Skill3_AnimationURL",
      "PeerID","Coins","Grade","Section","ImageURL_Attack_Left","ImageURL_Attack_Right","FullName",
      "ImageURL_IdleFront","ImageURL_IdleBack","ImageURL_Walk_Left","ImageURL_Walk_Right","ImageURL_Walk_Up","ImageURL_Walk_Down"
    ];

    for (const row of rows) {
      const obj = {};
      row.forEach((val, i) => keys[i] && (obj[keys[i]] = val));
      if (obj.Email === email) return obj;
    }
    return null;
  } catch (err) {
    console.error("Error fetching player data:", err);
    return null;
  }
}

// =======================
// Socket.IO
// =======================
io.on("connection", async (socket) => {
  console.log("🟢 Player connected:", socket.id);

  // Get email from query params
  const email = socket.handshake.query.email;
  const pdata = await getPlayerDataByEmail(email);

  // Initialize player state
  players[socket.id] = {
    x: Number(pdata?.PositionX || 0),
    y: Number(pdata?.PositionY || 0),
    lastDir: pdata?.MovementAnimation || "down",
    attacking: false,
    images: {
      idleFront: pdata?.ImageURL_IdleFront,
      idleBack: pdata?.ImageURL_IdleBack,
      walkLeft: pdata?.ImageURL_Walk_Left,
      walkRight: pdata?.ImageURL_Walk_Right,
      walkUp: pdata?.ImageURL_Walk_Up,
      walkDown: pdata?.ImageURL_Walk_Down,
      attackLeft: pdata?.ImageURL_Attack_Left,
      attackRight: pdata?.ImageURL_Attack_Right
    }
  };

  // Send current players to the new player
  socket.emit("currentPlayers", players);

  // Notify others about new player
  socket.broadcast.emit("newPlayer", { id: socket.id, ...players[socket.id] });

  // Player movement
  socket.on("move", (data) => {
    if (!players[socket.id]) return;
    players[socket.id].x = data.x;
    players[socket.id].y = data.y;
    players[socket.id].lastDir = data.lastDir;
    players[socket.id].attacking = data.attacking || false;

    socket.broadcast.emit("playerMoved", { id: socket.id, ...players[socket.id] });
  });

  // Attack animation
  socket.on("attack", (data) => {
    if (!players[socket.id]) return;
    players[socket.id].attacking = true;
    socket.broadcast.emit("playerAttacked", { id: socket.id, dir: data.dir });

    // Reset attacking
    setTimeout(() => {
      if (players[socket.id]) players[socket.id].attacking = false;
    }, 400);
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log("🔴 Player disconnected:", socket.id);
    delete players[socket.id];
    socket.broadcast.emit("playerDisconnected", socket.id);
  });
});

// =======================
// Start Server
// =======================
server.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});
