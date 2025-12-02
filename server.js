// ====== SERVER.JS ======
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаём папку public
app.use(express.static("public"));

// Подключения WebRTC
io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Подключение к комнате (например "room1")
    socket.on("join", (room) => {
        socket.join(room);
        console.log(`User ${socket.id} joined room ${room}`);

        socket.to(room).emit("user-joined", socket.id);
    });

    // Передача SDP offer/answer
    socket.on("signal", (data) => {
        socket.to(data.room).emit("signal", data);
    });

    // Передача ICE-кандидатов
    socket.on("ice-candidate", (data) => {
        socket.to(data.room).emit("ice-candidate", data);
    });

    // Чат
    socket.on("chat-message", (data) => {
        io.to(data.room).emit("chat-message", {
            user: data.user,
            text: data.text
        });
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});


