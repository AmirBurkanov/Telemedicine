// =============================
//       WebRTC Signaling Server
// =============================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);

// --- Важно для Android: разрешаем внешние подключения ---
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public"))); // папка с index.html и app.js

let users = {}; // socket.id : true

// =============================
//   Новый пользователь подключён
// =============================
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    users[socket.id] = true;

    // Шлём список активных пользователей ВСЕМ
    io.emit("userList", Object.keys(users));

    // =============================
    // СИГНАЛИНГ
    // =============================
    socket.on("signal", (payload) => {
        const target = payload.target;
        if (users[target]) {
            io.to(target).emit("signal", {
                from: socket.id,
                data: payload.data
            });
        }
    });

    // =============================
    // Отключение
    // =============================
    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        delete users[socket.id];
        io.emit("userList", Object.keys(users));
    });
});

// =============================
//     Запуск сервера
// =============================
const PORT = process.env.PORT || 3000;

// ВАЖНО: слушаем 0.0.0.0 — иначе Android не увидит сервер
server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Use http://<YOUR LAN IP>:${PORT} on Android`);
});
