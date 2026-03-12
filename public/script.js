const socket = io();
const setupContainer = document.getElementById('setup-container');
const mainContainer = document.getElementById('main-container');
const roomIdInput = document.getElementById('roomIdInput');
const joinBtn = document.getElementById('joinBtn');
const toggleShareBtn = document.getElementById('toggleShareBtn');
const toggleMicBtn = document.getElementById('toggleMicBtn');
const leaveBtn = document.getElementById('leaveBtn');
const displayRoomId = document.getElementById('display-room-id');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('localVideo');
const localContainer = document.getElementById('local-video-container');
const uploadSpeedEl = document.getElementById('upload-speed');
const downloadSpeedEl = document.getElementById('download-speed');

let currentRoomId = null;
let screenStream = null;
let micStream = null;
let peers = {}; // { userId: { pc, senders: {}, remoteStream } }
const iceConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };

// 统计变量
let lastBytesSent = 0;
let lastBytesReceived = 0;

joinBtn.onclick = () => {
    const roomId = roomIdInput.value.trim();
    if (!roomId) return alert('请输入房间号');
    currentRoomId = roomId;
    displayRoomId.innerText = roomId;
    setupContainer.classList.add('hidden');
    mainContainer.classList.remove('hidden');
    socket.emit('join-room', roomId);
    startStatsInterval();
};

leaveBtn.onclick = () => location.reload();

// --- 麦克风逻辑 ---
toggleMicBtn.onclick = async () => {
    if (micStream) {
        stopMic();
    } else {
        await startMic();
    }
};

async function startMic() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        toggleMicBtn.innerText = '关闭麦克风';
        toggleMicBtn.classList.add('active');

        const track = micStream.getAudioTracks()[0];
        Object.values(peers).forEach(p => {
            if (p.senders.mic) {
                p.senders.mic.replaceTrack(track);
            } else {
                p.senders.mic = p.pc.addTrack(track, micStream);
            }
        });
    } catch (err) { console.error('麦克风失败:', err); }
}

function stopMic() {
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        Object.values(peers).forEach(p => {
            if (p.senders.mic) {
                p.senders.mic.replaceTrack(null);
            }
        });
        micStream = null;
    }
    toggleMicBtn.innerText = '开启麦克风';
    toggleMicBtn.classList.remove('active');
}

// --- 屏幕共享逻辑 ---
toggleShareBtn.onclick = async () => {
    if (screenStream) {
        stopSharing();
    } else {
        await startSharing();
    }
};

async function startSharing() {
    try {
        // 请求视频 + 屏幕音频
        screenStream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { frameRate: { ideal: 30 } }, 
            audio: true 
        });
        
        const audioTracks = screenStream.getAudioTracks();
        if (audioTracks.length > 0) {
            console.log('✅ 成功捕获屏幕音轨:', audioTracks[0].label);
        } else {
            console.warn('⚠️ 未捕获到屏幕音轨。提示：共享“整个屏幕”或“标签页”时请勾选“共享音频”复选框。');
        }

        localVideo.srcObject = screenStream;
        localContainer.classList.add('sharing');
        toggleShareBtn.innerText = '停止共享屏幕';
        toggleShareBtn.classList.add('danger');

        screenStream.getVideoTracks()[0].onended = () => stopSharing();

        Object.values(peers).forEach(p => {
            screenStream.getTracks().forEach(track => {
                if (track.kind === 'video') {
                    p.senders.video = p.pc.addTrack(track, screenStream);
                } else {
                    p.senders.screenAudio = p.pc.addTrack(track, screenStream);
                }
            });
        });

        socket.emit('update-status', { roomId: currentRoomId, isSharing: true });
    } catch (err) { console.error('共享失败:', err); }
}

function stopSharing() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        Object.values(peers).forEach(p => {
            if (p.senders.video) { try { p.pc.removeTrack(p.senders.video); } catch(e){} delete p.senders.video; }
            if (p.senders.screenAudio) { try { p.pc.removeTrack(p.senders.screenAudio); } catch(e){} delete p.senders.screenAudio; }
        });
        screenStream = null;
    }
    localVideo.srcObject = null;
    localContainer.classList.remove('sharing');
    toggleShareBtn.innerText = '开始共享屏幕';
    toggleShareBtn.classList.remove('danger');
    socket.emit('update-status', { roomId: currentRoomId, isSharing: false });
}

// --- WebRTC 核心 ---
function createPeerConnection(userId) {
    const pc = new RTCPeerConnection(iceConfig);
    const remoteStream = new MediaStream();
    const peerObj = { pc, senders: {}, remoteStream };
    peers[userId] = peerObj;
    
    createRemoteVideoElement(userId);

    pc.onnegotiationneeded = async () => {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('signal', { to: userId, signal: pc.localDescription });
        } catch (err) { console.error('Negotiation error:', err); }
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { to: userId, signal: e.candidate });
    };

    pc.ontrack = (e) => {
        console.log(`Received ${e.track.kind} track from: ${userId}`);
        const remoteVideo = document.getElementById(`video-${userId}`);
        const container = document.getElementById(`container-${userId}`);
        
        // 将收到的轨道添加到该用户的持久流中
        peerObj.remoteStream.addTrack(e.track);
        
        // 【关键修复】重新绑定 srcObject 并强制播放，确保新加入的音轨（如屏幕声音）生效
        remoteVideo.srcObject = null;
        remoteVideo.srcObject = peerObj.remoteStream;
        
        remoteVideo.play().catch(err => console.warn('自动播放失败:', err));

        if (e.track.kind === 'video') {
            container.classList.add('sharing');
        }
    };

    return peerObj;
}

socket.on('user-connected', async (userId) => {
    const p = createPeerConnection(userId);
    if (screenStream) {
        screenStream.getTracks().forEach(t => {
            if (t.kind === 'video') p.senders.video = p.pc.addTrack(t, screenStream);
            else p.senders.screenAudio = p.pc.addTrack(t, screenStream);
        });
    }
    if (micStream) {
        p.senders.mic = p.pc.addTrack(micStream.getAudioTracks()[0], micStream);
    }
    setTimeout(async () => {
        if (p.pc.signalingState === 'stable' && Object.keys(p.senders).length === 0) {
            const offer = await p.pc.createOffer();
            await p.pc.setLocalDescription(offer);
            socket.emit('signal', { to: userId, signal: p.pc.localDescription });
        }
    }, 500);
});

socket.on('signal', async (data) => {
    const { from, signal } = data;
    let p = peers[from] || createPeerConnection(from);
    let pc = p.pc;
    try {
        if (signal.type === 'offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            if (screenStream) {
                screenStream.getTracks().forEach(t => {
                    if (t.kind === 'video' && !p.senders.video) p.senders.video = pc.addTrack(t, screenStream);
                    if (t.kind === 'audio' && !p.senders.screenAudio) p.senders.screenAudio = pc.addTrack(t, screenStream);
                });
            }
            if (micStream && !p.senders.mic) {
                p.senders.mic = pc.addTrack(micStream.getAudioTracks()[0], micStream);
            }
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit('signal', { to: from, signal: pc.localDescription });
        } else if (signal.type === 'answer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
            await pc.addIceCandidate(new RTCIceCandidate(signal));
        }
    } catch (err) { console.error('Signal error:', err); }
});

socket.on('user-disconnected', (userId) => {
    if (peers[userId]) { peers[userId].pc.close(); delete peers[userId]; }
    const el = document.getElementById(`container-${userId}`);
    if (el) el.remove();
});

socket.on('user-status-updated', (data) => {
    const el = document.getElementById(`container-${data.userId}`);
    if (el) data.isSharing ? el.classList.add('sharing') : el.classList.remove('sharing');
});

function createRemoteVideoElement(userId) {
    if (document.getElementById(`container-${userId}`)) return;
    const div = document.createElement('div');
    div.id = `container-${userId}`;
    div.className = 'video-item';
    div.innerHTML = `
        <div class="placeholder"><span>对方未共享</span></div>
        <video id="video-${userId}" autoplay playsinline></video>
        <div class="label">访客 (${userId.substr(0,4)})</div>
        <span id="fps-${userId}" class="fps-counter">0 FPS</span>
    `;
    videoGrid.appendChild(div);
}

function startStatsInterval() {
    setInterval(async () => {
        let totalSent = 0, totalRecv = 0;
        for (const [userId, p] of Object.entries(peers)) {
            if (!p.pc) continue;
            const stats = await p.pc.getStats();
            stats.forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    const fpsEl = document.getElementById(`fps-${userId}`);
                    if (fpsEl && r.framesPerSecond) fpsEl.innerText = `${Math.round(r.framesPerSecond)} FPS`;
                    totalRecv += (r.bytesReceived || 0);
                }
                if (r.type === 'outbound-rtp' && r.kind === 'video') totalSent += (r.bytesSent || 0);
            });
        }
        uploadSpeedEl.innerText = `${((totalSent - lastBytesSent)/1024).toFixed(1)} KB/s`;
        downloadSpeedEl.innerText = `${((totalRecv - lastBytesReceived)/1024).toFixed(1)} KB/s`;
        lastBytesSent = totalSent; lastBytesReceived = totalRecv;
    }, 1000);
}
