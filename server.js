// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Настройки CORS не требуются для простого деплоя на Render/локально
const io = new Server(server);

// Отдаём статические файлы
app.use(express.static('public'));

// При подключении клиента:
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // При любом подключении пересылаем список пользователей всем
  const emitUsers = () => {
    const ids = Array.from(io.sockets.sockets.keys());
    io.emit('users', ids);
  };

  emitUsers();

  // Унифицированный сигналинг — форвардим только указанному target
  socket.on('signal', (data) => {
    // data: { type, sdp?, candidate?, target }
    if (!data || !data.target) return;
    // отправляем целевому клиенту, добавляя sender
    io.to(data.target).emit('signal', { ...data, sender: socket.id });
  });

  // Резервный чат: пересылаем целевому
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
