#!/bin/bash
set -e

# ============================================
#  闪投 (Snapdrop Lite) - 一键部署脚本
#  支持: Ubuntu/Debian, CentOS/RHEL, Fedora, Alpine, Arch Linux
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# 默认端口配置 (可通过环境变量覆盖)
WEB_PORT=${WEB_PORT:-8080}
WS_PORT=${WS_PORT:-3001}
APP_NAME="snapdrop"
APP_DIR="/opt/$APP_NAME"

# ========== 工具函数 ==========

info()  { echo -e "${GREEN}[信息]${NC} $1"; }
warn()  { echo -e "${YELLOW}[提示]${NC} $1"; }
error() { echo -e "${RED}[错误]${NC} $1"; }
step()  { echo -e "${CYAN}[$1/$TOTAL_STEPS]${NC} $2"; }

TOTAL_STEPS=7

# 检测 Linux 发行版
detect_distro() {
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO_ID="$ID"
        DISTRO_LIKE="${ID_LIKE:-$ID}"
    elif [ -f /etc/redhat-release ]; then
        DISTRO_ID="centos"
        DISTRO_LIKE="rhel"
    else
        DISTRO_ID="unknown"
        DISTRO_LIKE="unknown"
    fi

    # 归类到包管理器族系
    case "$DISTRO_ID" in
        ubuntu|debian|linuxmint|pop)
            PKG_MANAGER="apt"
            ;;
        centos|rhel|rocky|alma|ol)
            PKG_MANAGER="yum"
            ;;
        fedora)
            PKG_MANAGER="dnf"
            ;;
        alpine)
            PKG_MANAGER="apk"
            ;;
        arch|manjaro|endeavouros)
            PKG_MANAGER="pacman"
            ;;
        *)
            # 尝试通过 ID_LIKE 推断
            if echo "$DISTRO_LIKE" | grep -qi "debian\|ubuntu"; then
                PKG_MANAGER="apt"
            elif echo "$DISTRO_LIKE" | grep -qi "rhel\|centos\|fedora"; then
                if command -v dnf &>/dev/null; then
                    PKG_MANAGER="dnf"
                else
                    PKG_MANAGER="yum"
                fi
            elif echo "$DISTRO_LIKE" | grep -qi "arch"; then
                PKG_MANAGER="pacman"
            elif command -v apt-get &>/dev/null; then
                PKG_MANAGER="apt"
            elif command -v yum &>/dev/null; then
                PKG_MANAGER="yum"
            elif command -v dnf &>/dev/null; then
                PKG_MANAGER="dnf"
            elif command -v apk &>/dev/null; then
                PKG_MANAGER="apk"
            elif command -v pacman &>/dev/null; then
                PKG_MANAGER="pacman"
            else
                error "无法识别的 Linux 发行版: $DISTRO_ID"
                error "请手动安装 nginx 和 nodejs 后再运行此脚本"
                exit 1
            fi
            ;;
    esac

    info "检测到系统: ${DISTRO_ID} (包管理器: ${PKG_MANAGER})"
}

# 检测端口是否被占用，返回 0=占用, 1=空闲
check_port() {
    local port=$1
    if command -v ss &>/dev/null; then
        ss -tlnp 2>/dev/null | grep -q ":${port} "
    elif command -v netstat &>/dev/null; then
        netstat -tlnp 2>/dev/null | grep -q ":${port} "
    else
        # 都不可用时尝试直接绑定
        (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null && return 0 || return 1
    fi
}

# 找一个可用端口 (从指定端口开始往上找)
find_available_port() {
    local start_port=$1
    local port=$start_port
    local max_port=$((start_port + 100))

    while [ $port -lt $max_port ]; do
        if ! check_port $port; then
            echo $port
            return 0
        fi
        port=$((port + 1))
    done

    echo ""
    return 1
}

# 安装软件包
install_packages() {
    local packages="$@"
    case "$PKG_MANAGER" in
        apt)
            export DEBIAN_FRONTEND=noninteractive
            apt-get update -qq
            apt-get install -y -qq $packages > /dev/null 2>&1
            ;;
        yum)
            yum install -y -q $packages > /dev/null 2>&1
            ;;
        dnf)
            dnf install -y -q $packages > /dev/null 2>&1
            ;;
        apk)
            apk add --no-cache $packages > /dev/null 2>&1
            ;;
        pacman)
            pacman -Sy --noconfirm --needed $packages > /dev/null 2>&1
            ;;
    esac
}

# 获取各发行版的包名
get_package_names() {
    case "$PKG_MANAGER" in
        apt)
            PKG_NGINX="nginx"
            PKG_NODEJS="nodejs npm"
            PKG_CURL="curl"
            ;;
        yum|dnf)
            PKG_NGINX="nginx"
            PKG_NODEJS="nodejs npm"
            PKG_CURL="curl"
            ;;
        apk)
            PKG_NGINX="nginx"
            PKG_NODEJS="nodejs npm"
            PKG_CURL="curl"
            ;;
        pacman)
            PKG_NGINX="nginx"
            PKG_NODEJS="nodejs npm"
            PKG_CURL="curl"
            ;;
    esac
}

# 配置 Nginx (处理不同发行版的目录差异)
setup_nginx() {
    local nginx_conf_dir
    local nginx_sites_dir

    # Alpine 和部分发行版用 /etc/nginx/conf.d/
    if [ -d /etc/nginx/sites-available ]; then
        nginx_conf_dir="/etc/nginx/sites-available"
        nginx_sites_dir="/etc/nginx/sites-enabled"
    elif [ -d /etc/nginx/conf.d ]; then
        nginx_conf_dir="/etc/nginx/conf.d"
        nginx_sites_dir="/etc/nginx/conf.d"
    else
        # 创建目录结构
        mkdir -p /etc/nginx/conf.d
        nginx_conf_dir="/etc/nginx/conf.d"
        nginx_sites_dir="/etc/nginx/conf.d"
    fi

    # 写入 Nginx 配置
    cat > "${nginx_conf_dir}/${APP_NAME}.conf" << NGINX_EOF
server {
    listen ${WEB_PORT};
    server_name ${DOMAIN_NAME:-_};

    root ${APP_DIR}/client;
    index index.html;

    # 安全头
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    # 支持域名和IP访问
    location / {
        try_files \$uri \$uri/ =404;
    }

    # WebSocket 代理 (支持局域网和公网转发)
    location /server {
        proxy_pass http://127.0.0.1:${WS_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 健康检查端点
    location /health {
        access_log off;
        return 200 "ok";
        add_header Content-Type text/plain;
    }
}
NGINX_EOF

    # 如果使用 sites-available 模式，创建软链接
    if [ "$nginx_conf_dir" != "$nginx_sites_dir" ]; then
        ln -sf "${nginx_conf_dir}/${APP_NAME}.conf" "${nginx_sites_dir}/"
        # 移除默认站点 (如果存在且有冲突)
        if [ -f "${nginx_sites_dir}/default" ]; then
            # 检查默认站点是否监听相同端口
            if grep -q "listen.*${WEB_PORT}" "${nginx_sites_dir}/default" 2>/dev/null; then
                echo ""
                warn "检测到 Nginx 默认站点也监听端口 ${WEB_PORT}"
                echo -e "  将要执行的操作:"
                echo -e "    ${CYAN}rm -f ${nginx_sites_dir}/default${NC}"
                echo ""
                read -p "是否移除默认站点？(y/N): " confirm
                if [[ "$confirm" =~ ^[Yy]$ ]]; then
                    rm -f "${nginx_sites_dir}/default"
                    info "已移除默认站点"
                else
                    warn "已跳过，如果 Nginx 启动失败请手动处理端口冲突"
                fi
            fi
        fi
    fi

    # 测试配置
    if ! nginx -t 2>&1; then
        error "Nginx 配置测试失败！"
        error "可能是端口冲突，请检查: nginx -t"
        exit 1
    fi

    # 重载 Nginx 配置
    if systemctl is-active --quiet nginx 2>/dev/null; then
        systemctl reload nginx
        info "Nginx 配置已重载"
    else
        systemctl start nginx
        info "Nginx 已启动"
    fi
}

# 创建 systemd 服务
setup_systemd() {
    cat > /etc/systemd/system/${APP_NAME}.service << EOF
[Unit]
Description=闪投 WebSocket 文件传输服务
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/server
ExecStart=$(which node) ${APP_DIR}/server/index.js
Restart=always
RestartSec=3
Environment=PORT=${WS_PORT}
Environment=NODE_ENV=production
Environment=LAN_MODE=${LAN_MODE}

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${APP_NAME} --quiet 2>/dev/null || systemctl enable ${APP_NAME}
    systemctl restart ${APP_NAME}
}

# 配置防火墙
setup_firewall() {
    # 检测防火墙类型
    if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
        echo ""
        warn "检测到 UFW 防火墙处于活动状态"
        echo -e "  将要执行的操作:"
        echo -e "    ${CYAN}ufw allow ${WEB_PORT}/tcp${NC}"
        echo -e "    ${CYAN}ufw allow ${WS_PORT}/tcp${NC}"
        echo ""
        read -p "是否放行端口？(y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            ufw allow ${WEB_PORT}/tcp > /dev/null 2>&1
            ufw allow ${WS_PORT}/tcp > /dev/null 2>&1
            info "UFW 防火墙已放行端口 ${WEB_PORT} 和 ${WS_PORT}"
        else
            warn "已跳过防火墙配置，请手动放行端口"
        fi
    elif command -v firewall-cmd &>/dev/null && firewall-cmd --state 2>/dev/null | grep -q "running"; then
        echo ""
        warn "检测到 firewalld 防火墙处于活动状态"
        echo -e "  将要执行的操作:"
        echo -e "    ${CYAN}firewall-cmd --permanent --add-port=${WEB_PORT}/tcp${NC}"
        echo -e "    ${CYAN}firewall-cmd --permanent --add-port=${WS_PORT}/tcp${NC}"
        echo -e "    ${CYAN}firewall-cmd --reload${NC}"
        echo ""
        read -p "是否放行端口？(y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            firewall-cmd --permanent --add-port=${WEB_PORT}/tcp > /dev/null 2>&1
            firewall-cmd --permanent --add-port=${WS_PORT}/tcp > /dev/null 2>&1
            firewall-cmd --reload > /dev/null 2>&1
            info "firewalld 已放行端口 ${WEB_PORT} 和 ${WS_PORT}"
        else
            warn "已跳过防火墙配置，请手动放行端口"
        fi
    elif command -v iptables &>/dev/null && iptables -L INPUT -n 2>/dev/null | grep -q "DROP\|REJECT"; then
        echo ""
        warn "检测到 iptables 防火墙存在限制规则"
        echo -e "  将要执行的操作:"
        echo -e "    ${CYAN}iptables -I INPUT -p tcp --dport ${WEB_PORT} -j ACCEPT${NC}"
        echo -e "    ${CYAN}iptables -I INPUT -p tcp --dport ${WS_PORT} -j ACCEPT${NC}"
        echo ""
        read -p "是否放行端口？(y/N): " confirm
        if [[ "$confirm" =~ ^[Yy]$ ]]; then
            iptables -I INPUT -p tcp --dport ${WEB_PORT} -j ACCEPT > /dev/null 2>&1 || true
            iptables -I INPUT -p tcp --dport ${WS_PORT} -j ACCEPT > /dev/null 2>&1 || true
            # 尝试持久化规则
            if command -v iptables-save &>/dev/null; then
                iptables-save > /etc/iptables.rules 2>/dev/null || true
            fi
            info "iptables 已放行端口 ${WEB_PORT} 和 ${WS_PORT}"
        else
            warn "已跳过防火墙配置，请手动放行端口"
        fi
    else
        info "未检测到限制性防火墙规则，跳过配置"
    fi
}

# ========== 主流程 ==========

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      闪投 - 局域网文件传输部署工具     ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    error "请使用 root 权限运行: sudo bash deploy.sh"
    exit 1
fi

# 检测发行版
detect_distro
get_package_names

# ---------- 停止旧服务（避免自己和自己冲突） ----------
if systemctl is-active --quiet ${APP_NAME} 2>/dev/null; then
    info "检测到旧版 Snapdrop 服务正在运行，正在停止..."
    systemctl stop ${APP_NAME}
    sleep 1
fi

# ---------- 端口检测与自动分配 ----------
step 1 "检测端口..."

WEB_CONFLICT=false
WS_CONFLICT=false

# 检测 Web 端口（排除 nginx 自身占用的情况）
if check_port $WEB_PORT; then
    # 检查是否是 nginx 占用（nginx 配置会被覆盖，不算冲突）
    PORT_OWNER=$(ss -tlnp 2>/dev/null | grep ":${WEB_PORT} " | grep -o 'users:(([^)]*' | head -1 || true)
    if echo "$PORT_OWNER" | grep -q "nginx"; then
        info "端口 ${WEB_PORT} 被 Nginx 占用，配置将自动覆盖"
    else
        WEB_CONFLICT=true
        warn "端口 ${WEB_PORT} (Web) 已被其他服务占用:"
        (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":${WEB_PORT} " | head -3
        echo ""
        NEW_WEB_PORT=$(find_available_port $WEB_PORT)
        if [ -n "$NEW_WEB_PORT" ]; then
            info "自动分配 Web 端口: ${WEB_PORT} -> ${GREEN}${NEW_WEB_PORT}${NC}"
            WEB_PORT=$NEW_WEB_PORT
        else
            error "无法找到可用的 Web 端口 (已尝试 ${WEB_PORT}-$((WEB_PORT+100)))"
            exit 1
        fi
    fi
fi

# 检测 WebSocket 端口
if check_port $WS_PORT; then
    WS_CONFLICT=true
    warn "端口 ${WS_PORT} (WebSocket) 已被其他服务占用:"
    (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":${WS_PORT} " | head -3
    echo ""
    NEW_WS_PORT=$(find_available_port $WS_PORT)
    if [ -n "$NEW_WS_PORT" ]; then
        info "自动分配 WebSocket 端口: ${WS_PORT} -> ${GREEN}${NEW_WS_PORT}${NC}"
        WS_PORT=$NEW_WS_PORT
    else
        error "无法找到可用的 WebSocket 端口 (已尝试 ${WS_PORT}-$((WS_PORT+100)))"
        exit 1
    fi
fi

if [ "$WEB_CONFLICT" = false ] && [ "$WS_CONFLICT" = false ]; then
    info "端口 ${WEB_PORT} (Web) 和 ${WS_PORT} (WebSocket) 均可用"
fi

# ---------- 域名配置 ----------
step 2 "配置域名..."

echo -e "${CYAN}域名配置说明:${NC}"
echo -e "  - 有域名: 输入你的域名 (如 snapdrop.example.com)"
echo -e "  - 无域名: 直接回车，使用 IP 地址访问"
echo -e "  - 内网转发: 直接回车，通过 localhost 转发"
echo ""
read -p "请输入域名 (直接回车跳过): " DOMAIN_NAME

if [ -n "$DOMAIN_NAME" ]; then
    info "域名设置为: ${GREEN}${DOMAIN_NAME}${NC}"
    DOMAIN_NAME="$DOMAIN_NAME"
else
    info "使用 IP 地址或 localhost 访问"
    DOMAIN_NAME="_"
fi

# ---------- 网络模式配置 ----------
echo ""
echo -e "${CYAN}网络模式配置:${NC}"
echo -e "  - 局域网模式: 设备通过子网分组，同一局域网的设备能互相发现"
echo -e "  - 公网模式: 使用 STUN 服务器做 NAT 穿透，支持跨网络 P2P"
echo ""
read -p "是否启用局域网模式？(Y/n): " enable_lan
if [[ "$enable_lan" =~ ^[Nn]$ ]]; then
    LAN_MODE="false"
    info "已禁用局域网子网分组"
else
    LAN_MODE="true"
    info "已启用局域网子网分组"
fi

echo ""
read -p "是否启用 STUN 服务器（支持公网 P2P）？(y/N): " enable_stun
if [[ "$enable_stun" =~ ^[Yy]$ ]]; then
    ENABLE_STUN="true"
    info "已启用 STUN 服务器"
else
    ENABLE_STUN="false"
    info "仅使用局域网 P2P，不经过公网"
fi

# ---------- 安装依赖 ----------
step 3 "安装依赖 (nginx + nodejs)..."

install_packages $PKG_NGINX $PKG_NODEJS $PKG_CURL

# 确保 node 命令可用 (某些系统只有 nodejs 没有 node)
if ! command -v node &>/dev/null; then
    if command -v nodejs &>/dev/null; then
        ln -sf "$(which nodejs)" /usr/local/bin/node
    else
        error "Node.js 安装失败，请手动安装"
        exit 1
    fi
fi

NODE_VER=$(node -v 2>/dev/null || echo "未知")
NGINX_VER=$(nginx -v 2>&1 | grep -oP '[\d.]+' || echo "未知")
info "Node.js: ${NODE_VER}  |  Nginx: ${NGINX_VER}"

# ---------- 部署文件 ----------
step 4 "部署文件到 ${APP_DIR} ..."

# 备份旧版本 (如果存在)
if [ -d "$APP_DIR" ]; then
    BACKUP_DIR="${APP_DIR}.bak.$(date +%Y%m%d%H%M%S)"
    echo ""
    warn "检测到旧版本目录: ${APP_DIR}"
    echo -e "  将要执行的操作:"
    echo -e "    ${CYAN}mv ${APP_DIR} ${BACKUP_DIR}${NC}"
    echo -e "    ${CYAN}（旧文件将备份到 ${BACKUP_DIR}）${NC}"
    echo ""
    read -p "是否备份并覆盖？(Y/n): " confirm
    if [[ "$confirm" =~ ^[Nn]$ ]]; then
        error "已取消部署"
        exit 1
    fi
    mv "$APP_DIR" "$BACKUP_DIR"
    info "旧版本已备份到 ${BACKUP_DIR}"
fi

mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/client" "$APP_DIR/"
cp -r "$(dirname "$0")/server" "$APP_DIR/"

# 生成前端配置文件
if [ "$ENABLE_STUN" = "true" ]; then
    echo "window.SNAPDROP_ENABLE_STUN = true;" > "${APP_DIR}/client/config.js"
    info "已启用 STUN 服务器配置"
else
    echo "window.SNAPDROP_ENABLE_STUN = false;" > "${APP_DIR}/client/config.js"
    info "已禁用 STUN 服务器（仅局域网 P2P）"
fi

info "文件已部署"

# ---------- 安装 Node 依赖 ----------
step 5 "安装 Node.js 依赖..."
cd "$APP_DIR/server"
npm install --production --quiet 2>&1 | tail -1
info "Node 依赖安装完成"

# ---------- 配置服务 ----------
step 6 "配置系统服务..."
setup_nginx
setup_systemd
setup_firewall
info "WebSocket 服务已启动 (端口 ${WS_PORT})"
info "Nginx 已配置并启动 (端口 ${WEB_PORT})"

# ---------- 完成 ----------
step 7 "部署完成!"

# 获取服务器 IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP=$(ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="<服务器IP>"

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           部署成功!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${YELLOW}─── 访问地址 ───${NC}"
if [ "$DOMAIN_NAME" = "_" ]; then
    echo -e "  IP 访问:    ${GREEN}http://${SERVER_IP}:${WEB_PORT}${NC}"
    echo -e "  本地访问:   ${GREEN}http://localhost:${WEB_PORT}${NC}"
    echo -e "  内网转发:   ${GREEN}http://127.0.0.1:${WEB_PORT}${NC}"
else
    echo -e "  域名访问:   ${GREEN}http://${DOMAIN_NAME}:${WEB_PORT}${NC}"
    echo -e "  IP 访问:    ${GREEN}http://${SERVER_IP}:${WEB_PORT}${NC}"
    echo -e "  本地访问:   ${GREEN}http://localhost:${WEB_PORT}${NC}"
fi
echo ""
echo -e "  ${YELLOW}─── 端口配置 ───${NC}"
echo -e "  Web 端口:       ${GREEN}${WEB_PORT}${NC}"
echo -e "  WebSocket 端口: ${GREEN}${WS_PORT}${NC}"
echo -e "  ${CYAN}(如需修改端口，编辑 ${APP_DIR}/server/index.js 和 Nginx 配置)${NC}"
echo ""
echo -e "  ${YELLOW}─── 常用命令 ───${NC}"
echo -e "  查看状态:    ${GREEN}systemctl status ${APP_NAME}${NC}"
echo -e "  查看日志:    ${GREEN}journalctl -u ${APP_NAME} -f${NC}"
echo -e "  重启服务:    ${GREEN}systemctl restart ${APP_NAME}${NC}"
echo -e "  重启Nginx:   ${GREEN}systemctl restart nginx${NC}"
echo -e "  健康检查:    ${GREEN}curl http://localhost:${WEB_PORT}/health${NC}"
echo ""
echo -e "  ${YELLOW}─── 内网转发配置 (可选) ───${NC}"
echo -e "  如果使用 frp/ngrok 等工具转发，配置要点:"
echo -e "  1. 转发端口 ${WEB_PORT} 的 HTTP 流量"
echo -e "  2. 确保 WebSocket 路径 /server 能正确升级"
echo -e "  3. 域名解析到转发后的公网地址"
echo ""
echo -e "  ${YELLOW}─── 配置 HTTPS (可选) ───${NC}"
if [ "$DOMAIN_NAME" != "_" ]; then
    echo -e "  1. 确保域名已解析到服务器"
    echo -e "  2. 安装 certbot:"
    echo -e "     ${GREEN}apt install certbot python3-certbot-nginx${NC}  (Debian/Ubuntu)"
    echo -e "     ${GREEN}yum install certbot python3-certbot-nginx${NC}  (CentOS/RHEL)"
    echo -e "  3. 获取证书:"
    echo -e "     ${GREEN}certbot --nginx -d ${DOMAIN_NAME}${NC}"
    echo -e "  4. 重载 Nginx: ${GREEN}systemctl reload nginx${NC}"
else
    echo -e "  配置域名后才能启用 HTTPS"
    echo -e "  1. 将域名 A 记录指向 ${SERVER_IP}"
    echo -e "  2. 修改 Nginx 配置中的 server_name"
    echo -e "  3. 安装 certbot 并获取证书"
fi
echo ""
