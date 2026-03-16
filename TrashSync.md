# TrashSync - WebRTC 屏幕共享项目指南

## 项目概述
TrashSync 是一个高性能的点对点 (P2P) 屏幕共享与实时音视频同步系统。它利用 WebRTC 技术实现低延迟的画面传输，并支持多房间协作、屏幕音轨共享、麦克风独立控制以及实时网络监控。

### 核心技术栈
- **后端**: Node.js, Express, Socket.io (信令服务器)
- **前端**: 原生 JavaScript (WebRTC API), HTML5, CSS3
- **传输**: WebRTC (P2P Mesh 架构), STUN/TURN (穿透 NAT)
- **部署**: Nginx (反向代理与 SSL 终止)

## 项目结构
- `server.js`: 信令服务器核心逻辑，处理房间加入、信令转发及用户状态同步。
- `public/`: 前端静态资源目录。
  - `index.html`: 主界面，包含视频网格、控制栏及性能监控面板。
  - `script.js`: 前端核心逻辑，管理 WebRTC 生命周期、轨道同步、画质切换及性能优化。
  - `style.css`: 应用样式，定义响应式视频网格及交互组件。
- `nginx.conf`: 生产环境 Nginx 配置示例，支持 WebSocket 转发。

## 构建与运行

### 1. 安装依赖
```bash
npm install
```

### 2. 启动服务 (本地测试)
```bash
npm start
```
默认监听地址: `http://127.0.0.1:3000`

### 3. 生产部署
建议使用 `pm2` 进行进程管理：
```bash
pm2 start server.js --name trashsync
```
并配置 Nginx 转发 HTTPS 请求。

## 开发规范与约定

### 1. 性能优化 (v0.3+)
- **画质优先**: 默认开启 `maintain-framerate` 以确保高刷流畅。
- **码率控制**: 动态支持 4Mbps - 40Mbps 码率调整。
- **高刷支持**: 采集上限已开放至 120 FPS。

### 2. 信令同步
- 必须通过 `onnegotiationneeded` 机制自动处理轨道变更。
- 用户加入房间后应立即建立基础 P2P 握手，无论是否在共享。

### 3. 音频处理
- 屏幕音频与麦克风音频轨道应保持逻辑独立。
- 接收端采用持久化 `MediaStream` 绑定，避免切换功能时画面中断。

## 注意事项
- **安全**: 仅支持 HTTPS 环境（浏览器对 `getDisplayMedia` 的强制要求）。
- **STUN 选择**: 中国大陆建议首选 `stun.aliyun.com` 以获得最佳连接速度。
- **兼容性**: macOS 用户在共享“整个屏幕”时可能受限，建议共享“标签页”以传输系统声音。
