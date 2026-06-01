#!/bin/bash
set -e

# ============================================
#  Snapdrop 局域网文件传输 - 一键部署脚本
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

TOTAL_STEPS=6

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
    server_name _;

    root ${APP_DIR}/client;
    index index.html;

    # 安全头
    add_header X-Content-Type-Options nosniff;
    add_header X-Frame-Options DENY;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location /server {
        proxy_pass http://127.0.0.1:${WS_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Host \$host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX_EOF

    # 如果使用 sites-available 模式，创建软链接
    if [ "$nginx_conf_dir" != "$nginx_sites_dir" ]; then
        ln -sf "${nginx_conf_dir}/${APP_NAME}.conf" "${nginx_sites_dir}/"
        # 移除默认站点 (如果存在)
        rm -f "${nginx_sites_dir}/default"
    fi

    # 测试配置
    if ! nginx -t 2>&1; then
        error "Nginx 配置测试失败！"
        exit 1
    fi
}

# 创建 systemd 服务
setup_systemd() {
    cat > /etc/systemd/system/${APP_NAME}.service << EOF
[Unit]
Description=Snapdrop WebSocket 文件传输服务
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}/server
ExecStart=$(which node) ${APP_DIR}/server/index.js
Restart=always
RestartSec=3
Environment=PORT=${WS_PORT}

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ${APP_NAME} --quiet 2>/dev/null || systemctl enable ${APP_NAME}
    systemctl restart ${APP_NAME}
}

# ========== 主流程 ==========

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║    Snapdrop 局域网文件传输 - 部署工具  ║${NC}"
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

# ---------- 端口检测与自动分配 ----------
step 1 "检测端口..."

WEB_CONFLICT=false
WS_CONFLICT=false

if check_port $WEB_PORT; then
    WEB_CONFLICT=true
    warn "端口 ${WEB_PORT} (Web) 已被占用:"
    (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":${WEB_PORT} " | head -3
    NEW_WEB_PORT=$(find_available_port $WEB_PORT)
    if [ -n "$NEW_WEB_PORT" ]; then
        info "自动分配 Web 端口: ${WEB_PORT} -> ${GREEN}${NEW_WEB_PORT}${NC}"
        WEB_PORT=$NEW_WEB_PORT
    else
        error "无法找到可用的 Web 端口 (已尝试 ${WEB_PORT}-$((WEB_PORT+100)))"
        exit 1
    fi
fi

if check_port $WS_PORT; then
    WS_CONFLICT=true
    warn "端口 ${WS_PORT} (WebSocket) 已被占用:"
    (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | grep ":${WS_PORT} " | head -3
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

# ---------- 安装依赖 ----------
step 2 "安装依赖 (nginx + nodejs)..."

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
step 3 "部署文件到 ${APP_DIR} ..."

# 备份旧版本 (如果存在)
if [ -d "$APP_DIR" ]; then
    BACKUP_DIR="${APP_DIR}.bak.$(date +%Y%m%d%H%M%S)"
    warn "检测到旧版本，已备份到 ${BACKUP_DIR}"
    mv "$APP_DIR" "$BACKUP_DIR"
fi

mkdir -p "$APP_DIR"
cp -r "$(dirname "$0")/client" "$APP_DIR/"
cp -r "$(dirname "$0")/server" "$APP_DIR/"
info "文件已部署"

# ---------- 安装 Node 依赖 ----------
step 4 "安装 Node.js 依赖..."
cd "$APP_DIR/server"
npm install --production --quiet 2>&1 | tail -1
info "Node 依赖安装完成"

# ---------- 配置服务 ----------
step 5 "配置系统服务..."
setup_nginx
setup_systemd
info "WebSocket 服务已启动 (端口 ${WS_PORT})"
info "Nginx 已配置并启动 (端口 ${WEB_PORT})"

# ---------- 完成 ----------
step 6 "部署完成!"

# 获取服务器 IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -z "$SERVER_IP" ] && SERVER_IP=$(ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1)
[ -z "$SERVER_IP" ] && SERVER_IP="<服务器IP>"

echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           部署成功!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  访问地址: ${GREEN}http://${SERVER_IP}:${WEB_PORT}${NC}"
echo ""
echo -e "  ${YELLOW}─── 端口配置 ───${NC}"
echo -e "  Web 端口:       ${GREEN}${WEB_PORT}${NC}"
echo -e "  WebSocket 端口: ${GREEN}${WS_PORT}${NC}"
echo -e "  ${CYAN}(如需修改端口，编辑 ${APP_DIR}/server/index.js 和 Nginx 配置)${NC}"
echo ""
echo -e "  ${YELLOW}─── 常用命令 ───${NC}"
echo -e "  查看状态:  ${GREEN}systemctl status ${APP_NAME}${NC}"
echo -e "  查看日志:  ${GREEN}journalctl -u ${APP_NAME} -f${NC}"
echo -e "  重启服务:  ${GREEN}systemctl restart ${APP_NAME}${NC}"
echo -e "  重启Nginx: ${GREEN}systemctl restart nginx${NC}"
echo ""
echo -e "  ${YELLOW}─── 配置域名 (可选) ───${NC}"
echo -e "  1. 将域名 A 记录指向 ${SERVER_IP}"
echo -e "  2. 修改 Nginx 配置:"
echo -e "     ${GREEN}nano /etc/nginx/conf.d/${APP_NAME}.conf${NC}"
echo -e "     将 server_name _ 改为你的域名"
echo -e "  3. 如需 HTTPS, 安装 certbot:"
echo -e "     ${GREEN}apt install certbot python3-certbot-nginx${NC}  (Debian/Ubuntu)"
echo -e "     ${GREEN}yum install certbot python3-certbot-nginx${NC}  (CentOS/RHEL)"
echo -e "     ${GREEN}certbot --nginx -d your-domain.com${NC}"
echo -e "  4. 重载 Nginx: ${GREEN}systemctl reload nginx${NC}"
echo ""
