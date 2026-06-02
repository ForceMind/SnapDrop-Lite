# 闪投 (Snapdrop Lite)

局域网文件传输工具，基于 [Snapdrop](https://github.com/RobinLinus/snapdrop) 精简而来。

无需注册、无需安装，同一网络下的设备打开浏览器即可互传文件。

## 特性

- 同局域网设备自动发现，无需手动输入地址
- WebRTC 点对点传输，文件不经服务器，速度快且保护隐私
- 支持发送文件和文本消息
- 支持拖拽、粘贴图片发送
- PWA 支持，手机可添加到桌面
- 一键部署脚本，支持主流 Linux 发行版
- 支持域名访问、IP 访问、localhost 内网转发
- 全中文界面

## 架构

```
┌──────────┐   WebSocket (信令)   ┌──────────────┐   WebSocket (信令)   ┌──────────┐
│  设备 A  │ ◄──────────────────► │   服务器     │ ◄──────────────────► │  设备 B  │
│          │                      │  (Node.js)   │                      │          │
└────┬─────┘                      └──────────────┘                      └────┬─────┘
     │                                                                       │
     │                    WebRTC DataChannel (文件数据)                       │
     └───────────────────────────────────────────────────────────────────────┘
                            局域网直连，不经服务器
```

**服务器只负责设备发现和信令交换，文件传输走局域网 P2P 直连。**

当浏览器不支持 WebRTC 或 P2P 失败时，自动降级为 WebSocket 中转。

## 快速部署

### 服务器要求

- Linux 系统（Ubuntu/Debian/CentOS/Fedora/Alpine/Arch）
- root 权限
- Node.js 16+

### 一键部署

```bash
# 上传项目到服务器后执行
sudo bash deploy.sh
```

脚本会自动：
1. 检测 Linux 发行版并安装对应依赖（nginx + nodejs）
2. 检测端口冲突，自动分配可用端口
3. 配置域名（可选）
4. 配置网络模式（局域网/公网）
5. 构建混淆版本并部署到 `/opt/snapdrop`
6. 配置 systemd 服务、Nginx 反向代理和防火墙

### 自定义端口

```bash
# 通过环境变量指定端口
sudo WEB_PORT=9090 WS_PORT=3002 bash deploy.sh
```

默认端口：Web `8080`，WebSocket `3001`。

### 本地构建（可选）

如果需要手动构建混淆版本：

```bash
# 安装混淆工具
npm install -g terser

# 构建
bash build.sh
```

构建后生成 `dist/` 目录，包含：
- 混淆后的 JS 文件（带随机后缀，如 `network.a1b2c3d4.js`）
- 压缩后的 CSS 文件
- 更新后的 `index.html`

## 目录结构

## 网络模式

### 局域网模式（默认）

- 设备按子网分组（如 192.168.1.x 的设备在同一房间）
- 不使用 STUN 服务器，完全走局域网
- 文件传输不经公网，速度快且隐私安全

### 公网模式

- 使用 STUN 服务器做 NAT 穿透
- 支持跨网络 P2P 连接
- 文件传输走公网直连（不经服务器）

部署时会询问是否启用 STUN 服务器。

## 访问方式

### 1. IP 直接访问（默认）
```
http://服务器IP:8080
http://localhost:8080
```

### 2. 域名访问
部署时输入域名，或手动修改 Nginx 配置：
```bash
nano /etc/nginx/conf.d/snapdrop.conf
# 修改 server_name 为你的域名
```

### 3. 内网转发（frp/ngrok 等）
配置转发时注意：
- 转发端口 `8080` 的 HTTP 流量
- 确保 WebSocket 路径 `/server` 能正确升级
- 域名解析到转发后的公网地址

## 手动部署

如果不使用一键脚本，可以手动操作：

```bash
# 1. 安装依赖
apt install nginx nodejs npm   # Debian/Ubuntu
yum install nginx nodejs npm   # CentOS/RHEL

# 2. 复制文件
cp -r client/ /opt/snapdrop/client/
cp -r server/ /opt/snapdrop/server/

# 3. 安装 Node 依赖
cd /opt/snapdrop/server && npm install --production

# 4. 生成前端配置
echo "window.SNAPDROP_ENABLE_STUN = false;" > /opt/snapdrop/client/config.js

# 5. 启动服务
PORT=3001 LAN_MODE=true node /opt/snapdrop/server/index.js &

# 6. 配置 Nginx 反向代理（参考 deploy.sh 中的配置）
```

## 常用命令

```bash
systemctl status snapdrop     # 查看服务状态
journalctl -u snapdrop -f     # 查看实时日志
systemctl restart snapdrop    # 重启服务
systemctl restart nginx       # 重启 Nginx
curl http://localhost:8080/health  # 健康检查
```

## 目录结构

```
Snapdrop-Lite/
├── client/               # 前端源码
│   ├── index.html        # 主页面
│   ├── styles.css        # 样式
│   ├── config.js         # 部署配置
│   ├── manifest.json     # PWA 配置
│   ├── service-worker.js # 离线缓存
│   ├── scripts/
│   │   ├── network.js    # WebSocket + WebRTC 通信
│   │   ├── ui.js         # 界面交互
│   │   └── clipboard.js  # 剪贴板兼容
│   ├── images/           # 图标资源
│   └── sounds/           # 提示音
├── server/
│   ├── index.js          # WebSocket 信令服务器
│   └── package.json
├── dist/                 # 构建输出（混淆后）
│   ├── index.html        # 更新后的主页面
│   ├── *.js              # 混淆后的 JS（带随机后缀）
│   ├── *.css             # 压缩后的 CSS
│   └── ...
├── build.sh              # 构建脚本（混淆 + 随机后缀）
├── deploy.sh             # 部署脚本（自动调用 build.sh）
└── README.md
```

## 数据传输说明

| 场景 | 数据路径 | 说明 |
|------|----------|------|
| 同局域网 + WebRTC | 设备 A ↔ 设备 B | 局域网直连，速度最快 |
| 不同网络 + STUN | 设备 A ↔ 设备 B | 公网直连（需启用 STUN） |
| 浏览器不支持 WebRTC | 设备 A → 服务器 → 设备 B | WebSocket 中转 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3001 | WebSocket 服务端口 |
| LAN_MODE | true | 是否启用局域网子网分组 |
| NODE_ENV | production | Node.js 运行环境 |

## 技术栈

- **服务端**: Node.js + ws (WebSocket)
- **前端**: 原生 HTML/CSS/JS，无构建步骤
- **传输**: WebRTC DataChannel（P2P）
- **反向代理**: Nginx
- **服务管理**: systemd

## 许可证

基于 Snapdrop 项目，使用 [ISC License](LICENSE)。
