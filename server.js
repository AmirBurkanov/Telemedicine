// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// CORS разрешение для Render
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Статика
app.use(express.static('public'));

// Пользователи
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  const emitUsers = () => {
    const ids = Array.from(io.sockets.sockets.keys());
    io.emit('users', ids);
  };

  emitUsers();

  socket.on('signal', (data) => {
    if (!data || !data.target) return;
    io.to(data.target).emit('signal', { ...data, sender: socket.id });
  });

  socket.on('chat', ({ target, message }) => {
    if (!target) return;
    io.to(target).emit('chat', { sender: socket.id, message });
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    emitUsers();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
