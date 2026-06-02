#!/bin/bash
set -e

# ============================================
#  闪投 - 构建脚本
#  混淆 JS 文件并添加随机后缀
# ============================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

BUILD_DIR="dist"
VERSION=$(date +%s)

echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║      闪投 - 构建工具                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""

# 查找 terser
find_terser() {
    # 1. 直接命令
    command -v terser 2>/dev/null && return 0
    # 2. 搜索所有可能的路径
    local paths=(
        /root/.nvm/versions/node/*/bin/terser
        /home/*/.nvm/versions/node/*/bin/terser
        /usr/local/lib/node_modules/.bin/terser
        /usr/lib/node_modules/.bin/terser
        /usr/local/bin/terser
    )
    for p in "${paths[@]}"; do
        if [ -f "$p" ]; then
            TERSER_PATH="$p"
            return 0
        fi
    done
    return 1
}

TERSER_PATH=""

if find_terser; then
    if [ -z "$TERSER_PATH" ]; then
        TERSER_PATH="terser"
    fi
    echo -e "  找到 terser: ${TERSER_PATH}"
else
    echo -e "${YELLOW}[提示] 未找到 terser，正在安装...${NC}"
    npm install -g terser 2>&1 | tail -3
    if find_terser; then
        if [ -z "$TERSER_PATH" ]; then
            TERSER_PATH="terser"
        fi
        echo -e "  安装成功: ${TERSER_PATH}"
    else
        echo -e "${YELLOW}[警告] terser 安装失败，将使用原始文件${NC}"
        mkdir -p "$BUILD_DIR/scripts"
        cp -r client/images "$BUILD_DIR/"
        cp -r client/sounds "$BUILD_DIR/"
        cp client/manifest.json "$BUILD_DIR/"
        cp client/styles.css "$BUILD_DIR/styles.css"
        cp client/config.js "$BUILD_DIR/config.js"
        cp client/scripts/*.js "$BUILD_DIR/scripts/"
        cp client/service-worker.js "$BUILD_DIR/"
        cp client/index.html "$BUILD_DIR/"
        echo -e "${GREEN}已复制原始文件到 ${BUILD_DIR}/${NC}"
        exit 0
    fi
fi

# 创建 terser 包装函数
run_terser() {
    "$TERSER_PATH" "$@"
}

echo -e "  terser 版本: $(run_terser --version 2>/dev/null || echo '未知')"

# 清理构建目录
echo -e "${CYAN}[1/4] 清理构建目录...${NC}"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/scripts"

# 复制静态资源
echo -e "${CYAN}[2/4] 复制静态资源...${NC}"
cp -r client/images "$BUILD_DIR/"
cp -r client/sounds "$BUILD_DIR/"
cp client/manifest.json "$BUILD_DIR/"

# 混淆 JS 文件并添加随机后缀
echo -e "${CYAN}[3/4] 混淆 JavaScript 文件...${NC}"

# 生成随机后缀
RANDOM_SUFFIX=$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 8)

# 混淆 network.js
echo "  混淆 network.js..."
run_terser client/scripts/network.js \
    -c -m \
    -o "$BUILD_DIR/scripts/network.${RANDOM_SUFFIX}.js" \
    2>/dev/null || {
    run_terser client/scripts/network.js \
        -c \
        -o "$BUILD_DIR/scripts/network.${RANDOM_SUFFIX}.js"
}

# 混淆 ui.js
echo "  混淆 ui.js..."
run_terser client/scripts/ui.js \
    -c -m \
    -o "$BUILD_DIR/scripts/ui.${RANDOM_SUFFIX}.js" \
    2>/dev/null || {
    run_terser client/scripts/ui.js \
        -c \
        -o "$BUILD_DIR/scripts/ui.${RANDOM_SUFFIX}.js"
}

# 替换 ui.js 中的 service-worker.js 引用
sed -i "s|service-worker.js|service-worker.${RANDOM_SUFFIX}.js|g" "$BUILD_DIR/scripts/ui.${RANDOM_SUFFIX}.js" 2>/dev/null || \
sed -i '' "s|service-worker.js|service-worker.${RANDOM_SUFFIX}.js|g" "$BUILD_DIR/scripts/ui.${RANDOM_SUFFIX}.js"

# 混淆 clipboard.js
echo "  混淆 clipboard.js..."
run_terser client/scripts/clipboard.js \
    -c -m \
    -o "$BUILD_DIR/scripts/clipboard.${RANDOM_SUFFIX}.js" \
    2>/dev/null || {
    run_terser client/scripts/clipboard.js \
        -c \
        -o "$BUILD_DIR/scripts/clipboard.${RANDOM_SUFFIX}.js"
}

# 混淆 config.js
echo "  混淆 config.js..."
run_terser client/config.js \
    -c -m \
    -o "$BUILD_DIR/config.${RANDOM_SUFFIX}.js" \
    2>/dev/null || {
    cp client/config.js "$BUILD_DIR/config.${RANDOM_SUFFIX}.js"
}

# 混淆 service-worker.js
echo "  混淆 service-worker.js..."
run_terser client/service-worker.js \
    -c -m \
    -o "$BUILD_DIR/service-worker.${RANDOM_SUFFIX}.js" \
    2>/dev/null || {
    cp client/service-worker.js "$BUILD_DIR/service-worker.${RANDOM_SUFFIX}.js"
}

# 复制 CSS
cp client/styles.css "$BUILD_DIR/styles.${RANDOM_SUFFIX}.css"

# 生成 index.html 并替换引用
echo -e "${CYAN}[4/4] 生成 index.html...${NC}"

# 读取原始 HTML 并替换引用
sed \
    -e "s|config.js?v=[0-9.]*|config.${RANDOM_SUFFIX}.js|g" \
    -e "s|scripts/network.js?v=[0-9.]*|scripts/network.${RANDOM_SUFFIX}.js|g" \
    -e "s|scripts/ui.js?v=[0-9.]*|scripts/ui.${RANDOM_SUFFIX}.js|g" \
    -e "s|scripts/clipboard.js?v=[0-9.]*|scripts/clipboard.${RANDOM_SUFFIX}.js|g" \
    -e "s|styles.css?v=[0-9.]*|styles.${RANDOM_SUFFIX}.css|g" \
    -e "s|service-worker.js|service-worker.${RANDOM_SUFFIX}.js|g" \
    -e "s|manifest.json?v=[0-9.]*|manifest.json|g" \
    -e "s|sounds/blop.mp3?v=[0-9.]*|sounds/blop.mp3|g" \
    -e "s|sounds/blop.ogg?v=[0-9.]*|sounds/blop.ogg|g" \
    -e "s|images/favicon-96x96.png?v=[0-9.]*|images/favicon-96x96.png|g" \
    -e "s|images/apple-touch-icon.png?v=[0-9.]*|images/apple-touch-icon.png|g" \
    -e "s|images/mstile-150x150.png?v=[0-9.]*|images/mstile-150x150.png|g" \
    -e "s|images/android-chrome-192x192.png?v=[0-9.]*|images/android-chrome-192x192.png|g" \
    -e "s|name=\"version\" content=\"[^\"]*\"|name=\"version\" content=\"${VERSION}\"|g" \
    client/index.html > "$BUILD_DIR/index.html"

# 更新 service-worker.js 中的缓存名
sed -i "s|snapdrop-cache-v[0-9.]*|snapdrop-cache-${VERSION}|g" "$BUILD_DIR/service-worker.${RANDOM_SUFFIX}.js" 2>/dev/null || \
sed -i '' "s|snapdrop-cache-v[0-9.]*|snapdrop-cache-${VERSION}|g" "$BUILD_DIR/service-worker.${RANDOM_SUFFIX}.js"

# 统计结果
echo ""
echo -e "${GREEN}╔════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║           构建完成!                    ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════╝${NC}"
echo ""
echo -e "  构建目录: ${GREEN}${BUILD_DIR}/${NC}"
echo -e "  版本号:   ${GREEN}${VERSION}${NC}"
echo -e "  随机后缀: ${GREEN}${RANDOM_SUFFIX}${NC}"
echo ""
echo -e "  ${YELLOW}─── 生成的文件 ───${NC}"
ls -la "$BUILD_DIR"/scripts/ 2>/dev/null
echo ""
echo -e "  ${YELLOW}─── 部署命令 ───${NC}"
echo -e "  ${GREEN}sudo bash deploy.sh${NC}"
echo ""
