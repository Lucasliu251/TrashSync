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
const stunSelect = document.getElementById('stunSelect');
const qualitySelect = document.getElementById('qualitySelect');

let currentRoomId = null;
let screenStream = null;
let micStream = null;
let peers = {}; 
let iceConfig = { iceServers: [{ urls: 'stun:stun.aliyun.com' }] }; // 默认阿里云

// 统计变量
let lastBytesSent = 0;
let lastBytesReceived = 0;

// --- 初始化与 STUN 切换 ---
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

stunSelect.onchange = () => {
    const provider = stunSelect.value;
    if (provider === 'aliyun') iceConfig.iceServers = [{ urls: 'stun:stun.aliyun.com' }];
    else if (provider === 'tencent') iceConfig.iceServers = [{ urls: 'stun:stun.tencentcloud.com' }];
    else if (provider === 'google') iceConfig.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    console.log('STUN 服务器已切换为:', provider);
};

leaveBtn.onclick = () => location.reload();

// --- 画面控制 (全屏/静音) ---
function setupVideoControls(containerId, videoId) {
    const container = document.getElementById(containerId);
    const video = document.getElementById(videoId);
    const muteBtn = container.querySelector('.mute-btn');
    const fullscreenBtn = container.querySelector('.fullscreen-btn');

    muteBtn.onclick = () => {
        video.muted = !video.muted;
        muteBtn.innerText = video.muted ? '🔇' : '🔊';
        muteBtn.title = video.muted ? '解除静音' : '静音';
    };

    fullscreenBtn.onclick = () => {
        if (video.requestFullscreen) video.requestFullscreen();
        else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
        else if (video.msRequestFullscreen) video.msRequestFullscreen();
    };
}

// 初始化本地视频控制
setupVideoControls('local-video-container', 'localVideo');

// --- 性能优化核心函数 ---
async function applyPerformanceSettings(p) {
    if (!p || !p.pc) return;
    const senders = p.pc.getSenders();
    const quality = qualitySelect.value;
    
    // 解析预设
    let maxBitrate = 15 * 1000 * 1000;
    if (quality === '4k60') maxBitrate = 40 * 1000 * 1000;
    else if (quality === '720p30') maxBitrate = 4 * 1000 * 1000;

    for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
            if ('contentHint' in sender.track) sender.track.contentHint = 'motion';
            try { await sender.setDegradationPreference('maintain-framerate'); } catch (e) {}

            const params = sender.getParameters();
            if (!params.encodings) params.encodings = [{}];
            params.encodings[0].maxBitrate = maxBitrate;
            params.encodings[0].scaleResolutionDownBy = 1.0;
            try { await sender.setParameters(params); } catch (e) {}
        }
    }
}

// 监听画质切换
qualitySelect.onchange = async () => {
    console.log('正在动态应用新画质预设:', qualitySelect.value);
    if (screenStream) {
        const [width, height, fps] = parseQuality(qualitySelect.value);
        const videoTrack = screenStream.getVideoTracks()[0];
        try {
            await videoTrack.applyConstraints({ width, height, frameRate: fps });
        } catch (e) { console.warn('动态约束应用失败:', e); }
    }
    Object.values(peers).forEach(p => applyPerformanceSettings(p));
};

function parseQuality(val) {
    if (val === '1080p60') return [1920, 1080, 60];
    if (val === '1080p120') return [1920, 1080, 120];
    if (val === '720p30') return [1280, 720, 30];
    if (val === '4k60') return [3840, 2160, 60];
    return [1920, 1080, 60];
}

// --- 麦克风/共享逻辑 (复用之前优化后的逻辑，移除 reload) ---
toggleMicBtn.onclick = async () => {
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        Object.values(peers).forEach(p => { if (p.senders.mic) p.pc.removeTrack(p.senders.mic); delete p.senders.mic; });
        micStream = null;
        toggleMicBtn.innerText = '开启麦克风';
        toggleMicBtn.classList.remove('active');
    } else {
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            toggleMicBtn.innerText = '关闭麦克风';
            toggleMicBtn.classList.add('active');
            Object.values(peers).forEach(p => p.senders.mic = p.pc.addTrack(micStream.getAudioTracks()[0], micStream));
        } catch (err) { console.error(err); }
    }
};

toggleShareBtn.onclick = async () => {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        Object.values(peers).forEach(p => {
            if (p.senders.video) { p.pc.removeTrack(p.senders.video); delete p.senders.video; }
            if (p.senders.screenAudio) { p.pc.removeTrack(p.senders.screenAudio); delete p.senders.screenAudio; }
        });
        screenStream = null;
        localVideo.srcObject = null;
        localContainer.classList.remove('sharing');
        toggleShareBtn.innerText = '开始共享屏幕';
        toggleShareBtn.classList.remove('danger');
        socket.emit('update-status', { roomId: currentRoomId, isSharing: false });
    } else {
        try {
            const [width, height, fps] = parseQuality(qualitySelect.value);
            screenStream = await navigator.mediaDevices.getDisplayMedia({ 
                video: { width, height, frameRate: fps, resizeMode: 'none', cursor: "always" }, 
                audio: true 
            });
            localVideo.srcObject = screenStream;
            localContainer.classList.add('sharing');
            toggleShareBtn.innerText = '停止共享屏幕';
            toggleShareBtn.classList.add('danger');
            screenStream.getVideoTracks()[0].onended = () => toggleShareBtn.click();

            Object.values(peers).forEach(async p => {
                screenStream.getTracks().forEach(t => {
                    if (t.kind === 'video') p.senders.video = p.pc.addTrack(t, screenStream);
                    else p.senders.screenAudio = p.pc.addTrack(t, screenStream);
                });
                await applyPerformanceSettings(p);
            });
            socket.emit('update-status', { roomId: currentRoomId, isSharing: true });
        } catch (err) { console.error(err); }
    }
};

// --- WebRTC 核心 ---
function createPeerConnection(userId) {
    const pc = new RTCPeerConnection(iceConfig);
    const remoteStream = new MediaStream();
    const peerObj = { pc, senders: {}, remoteStream };
    peers[userId] = peerObj;
    
    createRemoteVideoElement(userId);
    setupVideoControls(`container-${userId}`, `video-${userId}`);

    // 【新增】监听连接状态，检测 NAT 失败
    pc.oniceconnectionstatechange = () => {
        const warningEl = document.getElementById('connection-warning');
        console.log(`ICE Connection State with ${userId}:`, pc.iceConnectionState);
        
        if (pc.iceConnectionState === 'failed') {
            warningEl.classList.remove('hidden');
        } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            // 如果有一个连接成功了，就隐藏警告（或者保持，取决于你的需求，这里选择隐藏）
            warningEl.classList.add('hidden');
        }
    };

    pc.onnegotiationneeded = async () => {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('signal', { to: userId, signal: pc.localDescription });
        } catch (err) { console.error(err); }
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) socket.emit('signal', { to: userId, signal: e.candidate });
    };

    pc.ontrack = (e) => {
        const video = document.getElementById(`video-${userId}`);
        const container = document.getElementById(`container-${userId}`);
        peerObj.remoteStream.addTrack(e.track);
        if (video.srcObject !== peerObj.remoteStream) video.srcObject = peerObj.remoteStream;
        video.play().catch(() => {});
        if (e.track.kind === 'video') container.classList.add('sharing');
    };

    return peerObj;
}

socket.on('user-connected', async (userId) => {
    const p = createPeerConnection(userId);
    if (screenStream) screenStream.getTracks().forEach(t => p.senders[t.kind === 'video' ? 'video' : 'screenAudio'] = p.pc.addTrack(t, screenStream));
    if (micStream) p.senders.mic = p.pc.addTrack(micStream.getAudioTracks()[0], micStream);
    await applyPerformanceSettings(p);
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
    try {
        if (signal.type === 'offer') {
            await p.pc.setRemoteDescription(new RTCSessionDescription(signal));
            if (screenStream) screenStream.getTracks().forEach(t => { if (!p.senders[t.kind==='video'?'video':'screenAudio']) p.senders[t.kind==='video'?'video':'screenAudio'] = p.pc.addTrack(t, screenStream); });
            if (micStream && !p.senders.mic) p.senders.mic = p.pc.addTrack(micStream.getAudioTracks()[0], micStream);
            const answer = await p.pc.createAnswer();
            await p.pc.setLocalDescription(answer);
            socket.emit('signal', { to: from, signal: p.pc.localDescription });
            await applyPerformanceSettings(p);
        } else if (signal.type === 'answer') {
            await p.pc.setRemoteDescription(new RTCSessionDescription(signal));
            await applyPerformanceSettings(p);
        } else if (signal.candidate) await p.pc.addIceCandidate(new RTCIceCandidate(signal));
    } catch (err) { console.error(err); }
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
        <div class="video-controls">
            <button class="icon-btn mute-btn" title="静音">🔊</button>
            <button class="icon-btn fullscreen-btn" title="全屏">⛶</button>
        </div>
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
