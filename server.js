// =======================
// server.js — FINAL FIXED VERSION
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
const PORT = process.env.PORT || 3000;

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
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

const sheets = google.sheets({ version: "v4", auth });

// =======================
// Express + Socket.IO Setup
// =======================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  transports: ["websocket"], // Prefer WebSocket transport
});

// Serve client files
app.use(express.static(path.join(__dirname, "public")));

// =======================
// Game State
// =======================
let players = {}; // { socketId: { ...playerData } }

// =======================
// Utility: Fetch Player Data from Sheets
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
      row.forEach((val, i) => (keys[i] && (obj[keys[i]] = val)));
      if (obj.Email?.trim().toLowerCase() === email.trim().toLowerCase()) return obj;
    }
    return null;
  } catch (err) {
    console.error("❌ Error fetching player data:", err);
    return null;
  }
}

// =======================
// Socket.IO Handlers
// =======================
io.on("connection", async (socket) => {
  try {
    const email = socket.handshake.auth?.email || "guest@local";
    console.log(`🟢 Player connected (${socket.id}) -> ${email}`);

    const pdata = await getPlayerDataByEmail(email);

    if (!pdata) {
      console.warn(`⚠️ No player found for email: ${email}`);
      socket.emit("noCharacterFound", { email });
      return;
    }

    // Initialize player state
    players[socket.id] = {
      id: socket.id,
      email: email,
      name: pdata.CharacterName || pdata.PlayerName || "Unnamed",
      class: pdata.CharacterClass || "Adventurer",
      x: Number(pdata.PositionX || 300),
      y: Number(pdata.PositionY || 300),
      lastDir: pdata.MovementAnimation || "down",
      attacking: false,
      images: {
        idleFront: pdata.ImageURL_IdleFront || "",
        idleBack: pdata.ImageURL_IdleBack || "",
        walkLeft: pdata.ImageURL_Walk_Left || "",
        walkRight: pdata.ImageURL_Walk_Right || "",
        walkUp: pdata.ImageURL_Walk_Up || "",
        walkDown: pdata.ImageURL_Walk_Down || "",
        attackLeft: pdata.ImageURL_Attack_Left || "",
        attackRight: pdata.ImageURL_Attack_Right || "",
      },
    };

    // Send all current players to the new one
    socket.emit("currentPlayers", players);

    // Notify others about the new player
    socket.broadcast.emit("newPlayer", { id: socket.id, ...players[socket.id] });

    // === Player movement ===
    socket.on("move", (data) => {
      try {
        if (!players[socket.id]) return;
        players[socket.id].x = data.x;
        players[socket.id].y = data.y;
        players[socket.id].lastDir = data.lastDir;
        players[socket.id].attacking = data.attacking || false;

        socket.broadcast.emit("playerMoved", { id: socket.id, ...players[socket.id] });
      } catch (err) {
        console.error("⚠️ Error in move event:", err);
      }
    });

    // === Player attack ===
    socket.on("attack", (data) => {
      try {
        if (!players[socket.id]) return;
        players[socket.id].attacking = true;
        socket.broadcast.emit("playerAttacked", { id: socket.id, dir: data.dir });

        // Reset attacking animation after short delay
        setTimeout(() => {
          if (players[socket.id]) players[socket.id].attacking = false;
        }, 400);
      } catch (err) {
        console.error("⚠️ Error in attack event:", err);
      }
    });

    // === Player disconnect ===
    socket.on("disconnect", () => {
      console.log(`🔴 Player disconnected (${socket.id}) -> ${email}`);
      delete players[socket.id];
      socket.broadcast.emit("playerDisconnected", socket.id);
    });

  } catch (err) {
    console.error("💥 Socket connection error:", err);
    socket.emit("errorMsg", { message: "Server error. Please reconnect." });
  }
});

// =======================
// Start Server
// =======================
server.listen(PORT, () => {
  console.log(`⚡ Server running on port ${PORT}`);
});
