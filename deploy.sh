#!/bin/bash
set -e

# ============================================
#  Snapdrop 一键部署脚本 (Ubuntu)
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

WEB_PORT=8080
WS_PORT=3001
APP_NAME="snapdrop"
APP_DIR="/opt/$APP_NAME"

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Snapdrop 一键部署脚本${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[错误] 请使用 root 权限运行: sudo bash deploy.sh${NC}"
    exit 1
fi

# 检查端口占用
echo -e "${YELLOW}[1/6] 检查端口...${NC}"
for port in $WEB_PORT $WS_PORT; do
    if ss -tlnp | grep -q ":$port "; then
        echo -e "${RED}[错误] 端口 $port 已被占用，请先释放或修改脚本中的端口配置${NC}"
        ss -tlnp | grep ":$port "
        exit 1
    fi
done
echo -e "  端口 $WEB_PORT (Web) 和 $WS_PORT (WebSocket) 可用"

# 安装依赖
echo -e "${YELLOW}[2/6] 安装依赖 (nginx + nodejs + npm)...${NC}"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx nodejs npm curl > /dev/null 2>&1

# 确保 node 可用 (某些 Ubuntu 版本 nodejs 不创建 node 软链接)
if ! command -v node &> /dev/null; then
    ln -sf /usr/bin/nodejs /usr/bin/node 2>/dev/null || true
fi

NODE_VER=$(node -v 2>/dev/null || echo "未安装")
echo -e "  Node.js: $NODE_VER"
echo -e "  Nginx: $(nginx -v 2>&1)"

# 部署文件
echo -e "${YELLOW}[3/6] 部署文件到 $APP_DIR ...${NC}"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/client" "$APP_DIR/"
cp -r "$(dirname "$0")/server" "$APP_DIR/"
echo -e "  文件已复制到 $APP_DIR"

# 安装 Node 依赖
echo -e "${YELLOW}[4/6] 安装 Node.js 依赖...${NC}"
cd "$APP_DIR/server"
npm install --production --quiet 2>&1 | tail -1
echo -e "  依赖安装完成"

# 创建 systemd 服务
echo -e "${YELLOW}[5/6] 配置系统服务...${NC}"
cat > /etc/systemd/system/$APP_NAME.service << EOF
[Unit]
Description=Snapdrop WebSocket Server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/server
ExecStart=/usr/bin/node $APP_DIR/server/index.js
Restart=always
RestartSec=3
Environment=PORT=$WS_PORT

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable $APP_NAME --quiet
systemctl restart $APP_NAME
echo -e "  WebSocket 服务已启动 (端口 $WS_PORT)"

# 配置 Nginx
cat > /etc/nginx/sites-available/$APP_NAME << EOF
server {
    listen $WEB_PORT;
    server_name _;

    root $APP_DIR/client;
    index index.html;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location /server {
        proxy_pass http://127.0.0.1:$WS_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Host \$host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
EOF

ln -sf /etc/nginx/sites-available/$APP_NAME /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t 2>&1
systemctl restart nginx
echo -e "  Nginx 已配置并启动 (端口 $WEB_PORT)"

# 完成
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  部署完成!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "  访问地址: ${GREEN}http://$(hostname -I | awk '{print $1}'):$WEB_PORT${NC}"
echo ""
echo -e "  ${YELLOW}--- 常用命令 ---${NC}"
echo -e "  查看状态:  systemctl status $APP_NAME"
echo -e "  查看日志:  journalctl -u $APP_NAME -f"
echo -e "  重启服务:  systemctl restart $APP_NAME"
echo -e "  重启Nginx: systemctl restart nginx"
echo ""
echo -e "  ${YELLOW}--- 配置域名 ---${NC}"
echo -e "  1. 将域名 A 记录指向本服务器 IP"
echo -e "  2. 修改 Nginx 配置:"
echo -e "     ${GREEN}nano /etc/nginx/sites-available/$APP_NAME${NC}"
echo -e "     将 server_name _ 改为你的域名, 如: server_name snapdrop.yourdomain.com;"
echo -e "  3. 如需 HTTPS, 安装 certbot:"
echo -e "     ${GREEN}apt install certbot python3-certbot-nginx${NC}"
echo -e "     ${GREEN}certbot --nginx -d snapdrop.yourdomain.com${NC}"
echo -e "  4. 重载 Nginx: ${GREEN}systemctl reload nginx${NC}"
echo ""
