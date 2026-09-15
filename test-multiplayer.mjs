import { WebSocket } from "ws";

async function testServerMultiplayer() {
  console.log("--- Starting Multiplayer WebSocket & Health Verification Test ---");

  // 1. Test /health REST endpoint
  try {
    const healthRes = await fetch("http://127.0.0.1:3000/health");
    if (healthRes.ok) {
      const data = await healthRes.json();
      console.log("✅ GET /health response:", data);
    } else {
      console.error("❌ GET /health returned status", healthRes.status);
    }
  } catch (err) {
    console.error("❌ Health check request failed:", err);
  }

  // 2. Simulate 2 Cross-Network Mobile Devices joining Room MB7777
  const roomCode = "MB7777";
  const wsUrl = "ws://127.0.0.1:3000/ws/multiplayer";

  const p1 = new WebSocket(wsUrl);
  const p2 = new WebSocket(wsUrl);

  await new Promise((resolve) => {
    let p1Joined = false;
    let p2Joined = false;
    let p2ReceivedMove = false;
    let damageReceived = false;

    p1.on("open", () => {
      console.log("📱 Mobile A (e.g. 5G) connected to WebSocket");
      p1.send(JSON.stringify({
        type: "join_room",
        roomCode,
        playerId: "pilot-device-A-5g",
        playerName: "Pilot 5G",
      }));
    });

    p2.on("open", () => {
      console.log("📱 Mobile B (e.g. Home Wi-Fi) connected to WebSocket");
      p2.send(JSON.stringify({
        type: "join_room",
        roomCode,
        playerId: "pilot-device-B-wifi",
        playerName: "Pilot Wi-Fi",
      }));
    });

    p1.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "room_joined") {
        p1Joined = true;
        console.log("✅ Mobile A successfully joined room:", msg.room.code);
        checkReady();
      }
      if (msg.type === "damage") {
        damageReceived = true;
        console.log("✅ Server Authoritative Damage broadcast received on Mobile A:", msg);
        finish();
      }
    });

    p2.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "room_joined") {
        p2Joined = true;
        console.log("✅ Mobile B successfully joined room:", msg.room.code);
        checkReady();
      }
      if (msg.type === "player_state" && msg.senderId === "pilot-device-A-5g") {
        p2ReceivedMove = true;
        console.log("✅ Mobile B received real-time position from Mobile A: x=", msg.x, "y=", msg.y, "z=", msg.z);
        // Simulate attack
        p2.send(JSON.stringify({
          type: "damage_event",
          targetId: "pilot-device-A-5g",
          damage: 75,
          isCritical: true,
        }));
      }
    });

    function checkReady() {
      if (p1Joined && p2Joined) {
        console.log("Both players in room. Broadcasting Mobile A position update...");
        p1.send(JSON.stringify({
          type: "combat_packet",
          x: 14.5,
          y: 0,
          z: -8.2,
          rotation: 1.57,
          isAttacking: true,
        }));
      }
    }

    function finish() {
      p1.close();
      p2.close();
      console.log("🎉 Test passed: Cross-network players successfully created room, synced movement, and received server-authoritative combat damage!");
      resolve();
    }
  });
}

testServerMultiplayer().catch(console.error);
