const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Opcional: defina ACCESS_CODE no servidor para só entrar quem tiver o código
const ACCESS_CODE = process.env.ACCESS_CODE || '';

app.use(express.static('public'));
app.get('/ice', (req, res) => {
  const list = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    list.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS,
    });
  }
  res.json(list);
});

// canais ficam em memória (reiniciar o servidor volta ao padrão)
const channels = new Map();
const addChannel = (name) => {
  const id = randomUUID().slice(0, 8);
  channels.set(id, { id, name, members: new Map(), messages: [] });
  return id;
};
addChannel('Geral');
addChannel('Jogos');

const snapshot = () =>
  [...channels.values()].map((c) => ({
    id: c.id,
    name: c.name,
    members: [...c.members].map(([id, name]) => ({ id, name })),
  }));
const broadcast = () => io.emit('channels', snapshot());

io.use((socket, next) => {
  if (ACCESS_CODE && socket.handshake.auth.code !== ACCESS_CODE) {
    return next(new Error('code'));
  }
  next();
});

io.on('connection', (socket) => {
  socket.data.name = String(socket.handshake.auth.name || 'Anônimo').slice(0, 20);
  socket.emit('channels', snapshot());

  const leave = () => {
    const ch = channels.get(socket.data.room);
    if (!ch) return;
    ch.members.delete(socket.id);
    socket.leave(ch.id);
    socket.to(ch.id).emit('peer:left', socket.id);
    socket.data.room = null;
    broadcast();
  };

  socket.on('create', (name) => {
    const clean = String(name || '').trim().slice(0, 24);
    if (clean) {
      addChannel(clean);
      broadcast();
    }
  });

  socket.on('join', (id, cb) => {
    const ch = channels.get(id);
    if (!ch) return;
    leave();
    const peers = [...ch.members].map(([pid, name]) => ({ id: pid, name }));
    ch.members.set(socket.id, socket.data.name);
    socket.join(id);
    socket.data.room = id;
    cb({ peers, messages: ch.messages });
    socket.to(id).emit('peer:joined', { id: socket.id, name: socket.data.name });
    broadcast();
  });

  socket.on('leave', leave);

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('share', (on) => {
    if (socket.data.room) socket.to(socket.data.room).emit('peer:share', { id: socket.id, on });
  });

  socket.on('chat', (text) => {
    const ch = channels.get(socket.data.room);
    const clean = String(text || '').trim().slice(0, 1000);
    if (!ch || !clean) return;
    const msg = { name: socket.data.name, text: clean, t: Date.now() };
    ch.messages.push(msg);
    if (ch.messages.length > 100) ch.messages.shift();
    io.to(ch.id).emit('chat', msg);
  });

  socket.on('disconnect', leave);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('minicall rodando em http://localhost:' + PORT));