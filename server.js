const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 加入房间
    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room: ${roomId}`);
        
        // 通知房间内其他人有新用户加入，触发 P2P 握手
        socket.to(roomId).emit('user-connected', socket.id);
    });

    // 转发信令 (Offer/Answer/Candidate)
    socket.on('signal', (data) => {
        // data.to 是目标用户的 socket.id
        io.to(data.to).emit('signal', {
            from: socket.id,
            signal: data.signal
        });
    });

    // 广播状态更新 (例如：开启/关闭共享)
    socket.on('update-status', (data) => {
        socket.to(data.roomId).emit('user-status-updated', {
            userId: socket.id,
            isSharing: data.isSharing
        });
    });

    socket.on('disconnecting', () => {
        socket.rooms.forEach(roomId => {
            if (roomId !== socket.id) {
                socket.to(roomId).emit('user-disconnected', socket.id);
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running on http://127.0.0.1:${PORT}`);
});
