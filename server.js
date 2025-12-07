// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server);

// Отдаём статические файлы
app.use(express.static('public'));

// При подключении клиента:
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    const emitUsers = () => {
        const ids = Array.from(io.sockets.sockets.keys());
        io.emit('users', ids);
    };

    emitUsers();

    // --- НОВЫЕ ОБРАБОТЧИКИ ДЛЯ ЗАПРОСА ВЫЗОВА ---

    // 1. Запрос на вызов: пересылаем target
    socket.on('call-request', (data) => {
        if (!data || !data.target) return;
        console.log(`Call request from ${socket.id} sent to ${data.target}`);
        io.to(data.target).emit('call-request', { sender: socket.id });
    });

    // 2. Ответ на вызов (Accept/Reject): пересылаем target
    socket.on('call-response', (data) => {
        if (!data || !data.target || !data.action) return;
        console.log(`Call response (${data.action}) from ${socket.id} sent to ${data.target}`);
        io.to(data.target).emit('call-response', { sender: socket.id, action: data.action });
    });

    // --- СУЩЕСТВУЮЩИЕ ОБРАБОТЧИКИ ---

    // Унифицированный сигналинг WebRTC (OFFER, ANSWER, CANDIDATE)
    socket.on('signal', (data) => {
        // data: { type, sdp?, candidate?, target }
        if (!data || !data.target) return;
        io.to(data.target).emit('signal', { ...data, sender: socket.id });
    });

    // Резервный чат
    socket.on('chat', ({ target, message }) => {
        if (!target) return;
        io.to(target).emit('chat', { sender: socket.id, message });
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        emitUsers();
    });
});

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
