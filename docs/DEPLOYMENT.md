# HTTPS 部署、迁移与回滚

当前只提供开发部署候选，未在用户正式服务器部署。

## 前提

- 管理自己的域名及 DNS；不要使用尚未购买确认的 zeydrop.com。
- Linux + systemd、Nginx、Node.js 22+、npm、openssl、flock、Git 和 GNU tar（自动化回归与候选归档使用）。脚本不会安装系统软件。
- 已签发且受浏览器信任、与域名匹配且有效期超过 24 小时的证书和私钥。
- 备份现有 `/etc/nginx`、systemd unit、服务配置和当前应用目录，确认 80 / 443 / loopback 3001 的使用者。

在干净检出中安装、测试、构建，然后按 README 的环境变量运行 `deploy.sh`。安装目录 `/opt/zeydrop/releases/<build-revision>`，活动版本 `/opt/zeydrop/current`。revision 同时覆盖客户端、服务端实现/包元数据、部署模板和锁文件；只改服务端也会产生新 release，不复用旧目录。Node 可执行文件先解析到 canonical 系统路径；位于 /root、/home、/run/user、/tmp、/var/tmp 的程序会因 systemd ProtectHome/PrivateTmp 被拒绝，NVM 私有目录不能直接用作服务 ExecStart。发布目录统一为 root 所有，目录 0755、普通文件 0644、原本可执行文件 0755，不保留 group/other 写权限，也不依赖安装者 umask。运行时只复制 server 入口、包元数据与本次 npm ci 的依赖，不复制 checkout 中本地 .env*；符号链接/非普通运行时输入在权限修改前被拒绝。Node 只监听 127.0.0.1:3001；外部只需 HTTPS，不应放行 3001。STUN 探测和设备 P2P 的 UDP 流量发生在客户端网络，不能靠开放服务器 3001 UDP 修复客户端 NAT。

脚本校验域名 / 证书路径、证书期限和域名、证书与密钥匹配，安装固定锁文件依赖、运行测试、确定性构建。部署和回滚使用同一个排他 flock，并在首次 npm ci 之前取得，覆盖安装、测试、构建和版本切换，避免同一 checkout 并发构建相互删除依赖或 dist。锁被占用时明确返回 busy/临时失败（退出码 75），包含安装/构建期间的合法占用；稍后重试，不应据此判定已部署版本故障。修改配置前备份受管文件、旧活动目录及服务状态；失败 trap 尝试恢复，备份目录在失败时保留供检查。启动新服务后，脚本在最多 10 秒内执行真实回环 WebSocket hello 校验，通过后才报告部署成功；仅进程 active 或静态 /health 不够。探测不创建邀请、不传文件，也不打印或保存返回的身份/恢复令牌。此路径尚未在真实 systemd 主机演练。通过 systemd `zeydrop` 运行无特权账号，Nginx 反代 WSS，配置 Origin 只接受 `https://<DOMAIN>`。

静态 `/health` 仅证明 Nginx 服务就绪；必须另外实际执行 WS hello、邀请两端配对、candidate pair、文件校验才能证明信令 / P2P 可用。开发 CI 中增加 `node tests/https-proxy.cjs`：临时自签名 TLS 证书和非特权端口启动**真实 Nginx/WSS 同主机双客户端配对**，并验证上传拒绝和安全头；只作为部署模板的云端演练，不能替代正式证书续期、systemd 重启或真实公网测试。不得将静态健康检查写成完整产品验收。

## 从旧 Snapdrop 安装迁移

不删除 `/opt/snapdrop`、旧服务配置或 Git 历史。若检测到旧 `snapdrop` 服务仍运行，部署脚本退出，不会自动停止它。

1. 记录旧服务启动参数、Nginx 文件和端口；备份原目录与配置。
2. 在独立测试主机或临时 HTTPS 域名验证候选版本，完成 TEST_MATRIX 中对应测试。
3. 安排切换时关闭旧服务、禁用发生冲突的旧 Nginx server block。保留文件以便回滚。
4. 执行新部署，核查 `systemctl status zeydrop`、`nginx -t`、实际浏览器两端 WSS / 直连及完整文件校验。
5. 若失败，停止新服务并恢复原 Nginx、unit 与活动目录。不要同时启用两个竞争同域名 / 端口的配置。

旧的短房间号、cookie peer ID 和 LAN_MODE 行为不迁移为新会话凭证。旧页面协议与 v2 不兼容；要求双方刷新到同一新版。

## 回滚

`sudo bash scripts/rollback.sh` 切换到 `/opt/zeydrop/previous` 记录的上一版静态资源和信令实现，然后重启服务并检查真实信令 hello，成功后才更新上一版标记。重启、信令就绪或 Nginx 切换失败时，脚本尝试恢复回滚前的活动目标，保留原上一版标记，以便检查和重试。恢复本身也可能失败，必须查看实际服务状态；不能把失败后的“尝试恢复”当作业务已恢复。它用于相同部署模板的版本回滚；**不负责恢复被手动修改的域名、TLS、systemd 或 Nginx 配置**。涉及配置变更应恢复前述备份。

发布后不立即删除旧 release，以便回滚。Service Worker 不在传输中强制激活；提示用户传输结束后关闭本站所有标签，再打开使新 shell 生效。回滚也要检查 PWA shell 版本。

## 未发布构建归档（仅供隔离测试）

Node/协议测试、依赖审计、构建一致性和临时 Nginx HTTPS/WSS 检查通过后，CI 在浏览器安装和浏览器 E2E **之前**运行 `scripts/package-candidate.mjs`，产出确定性源码/构建归档 `zeydrop-candidate.tar.gz`、SHA-256 校验文件和 `candidate-manifest.json`。GitHub Actions 以 `zeydrop-unreleased-source-candidate` 保存 7 天。**附件存在只说明源码/构建阶段产物可下载，不表示 Chromium/Firefox/WebKit、真实公网、Safari 或部署验收通过；必须另查同一次 run 的全部浏览器步骤和发布门槛。** 浏览器安装、环境检查或产品测试失败时，整体 CI 仍然标红，该附件仍只是隔离测试材料。归档只从干净 HEAD 的受版本管理源码清单和经 check-build 复验的 dist 生成；未提交的源码修改会拒绝打包，未追踪本地文件不会被复制。打包器拒绝符号链接、.env*、常见凭据配置和密钥/证书文件、未知 dist 资源；限制单文件和总输入大小。归档权限与时间戳归一化，candidate-manifest.json 逐文件记录来源、字节数、权限和 SHA-256，对应精确 source commit / build revision。

打包器对输入执行**有限规则的秘密扫描**（私钥 PEM、GitHub token、AWS access key、OpenAI project key 模式），拒绝时只打印路径和规则名称，不打印匹配值。此扫描不能识别所有凭据、编码/拆分秘密或所有隐私数据，不能替代人工审查、完整安全扫描或签名；开发归档仍不是稳定 Release。

使用者下载后先用 `sha256sum -c zeydrop-candidate.tar.gz.sha256` 检查本地归档完整性；SHA-256 并非独立身份签名或生产审核。仅允许在独立测试主机上用现有部署文档练习安装与回滚，不得将 CI 成功等同真实跨运营商、iOS Safari、证书续期或 production readiness。

## 发布前门槛

- 全部自动化检查通过；审查对应 commit，不能使用旧提交的绿灯。
- 实机验证 HTTPS/WSS、证书续期、systemd 重启、配置迁移和回滚。
- 跨宽带 / 蜂窝 / 运营商 / IPv6 / 严格 NAT 测试，记录失败及原因。
- 对照两个方向传输、拒绝 / 暂停 / 取消 / 文件校验、大文件能力和后台切换。
- 浏览器 Safari / iOS 无流式文件 picker 时，超过 64 MiB 必须拒绝；不能以模拟 picker 测试替代实际授权和保存验证。

## 云端可重复验证

`npm test` 包含打包与发布回归：临时独立 Git 仓库验证不带入未追踪 .env.production / 本地记录、拒绝已追踪凭据与令牌、拒绝 symlink/意外构建资源/脏 HEAD、重复归档字节一致。部署探测使用实际回环 WS 服务验证合法 Origin 和截止时间。回滚事务测试在临时目录中运行仅替换路径及 root 检查的脚本副本，并用模拟服务管理器注入重启/就绪失败，核对活动版本和上一版标记恢复；另覆盖锁必须先于 npm 安装、umask 077 下的可读权限/可执行位、符号链接不越界和 Node 系统路径解析；**没有运行真实 systemd、修改 /opt 或 /etc，也不能代替真实服务器验收**。

手动诊断本机信令（在已安装的测试主机）：

```bash
node scripts/check-signaling.cjs --env /etc/zeydrop/signaling.env \
  --server-root /opt/zeydrop/current/server --timeout 10000
```

该命令仅检查允许的回环地址上能完成授权 hello；不证明 Nginx/TLS、两设备 ICE、文件内容一致或公网 NAT 已验收。

2026-11-06可测试代码为cfdda0c，CI45全通过，源码/构建附件13499876562及精确SHA-256见 TEST_REPORT_20261106。Linux Playwright WebKit的Avahi/NSS准备仅作用临时CI Runner，不是Zeydrop服务端依赖、NAT服务或文件中继，勿把CI环境脚本用于用户主机。真实部署回滚仍未演练。
