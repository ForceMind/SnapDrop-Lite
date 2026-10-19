# HTTPS 部署、迁移与回滚

当前只提供开发部署候选，未在用户正式服务器部署。

## 前提

- 管理自己的域名及 DNS；不要使用尚未购买确认的 zeydrop.com。
- Linux + systemd、Nginx、Node.js 22+、npm、openssl。脚本不会安装系统软件。
- 已签发且受浏览器信任、与域名匹配且有效期超过 24 小时的证书和私钥。
- 备份现有 `/etc/nginx`、systemd unit、服务配置和当前应用目录，确认 80 / 443 / loopback 3001 的使用者。

在干净检出中安装、测试、构建，然后按 README 的环境变量运行 `deploy.sh`。安装目录 `/opt/zeydrop/releases/<build-revision>`，活动版本 `/opt/zeydrop/current`。Node 只监听 127.0.0.1:3001；外部只需 HTTPS，不应放行 3001。STUN 探测和设备 P2P 的 UDP 流量发生在客户端网络，不能靠开放服务器 3001 UDP 修复客户端 NAT。

脚本校验域名 / 证书路径、证书期限和域名、证书与密钥匹配，安装固定锁文件依赖、运行测试、确定性构建。通过 systemd `zeydrop` 运行无特权账号，Nginx 反代 WSS，配置 Origin 只接受 `https://<DOMAIN>`。

静态 `/health` 仅证明 Nginx 服务就绪；必须另外实际执行 WS hello、邀请两端配对、candidate pair、文件校验才能证明信令 / P2P 可用。不得将静态健康检查写成完整产品验收。

## 从旧 Snapdrop 安装迁移

不删除 `/opt/snapdrop`、旧服务配置或 Git 历史。若检测到旧 `snapdrop` 服务仍运行，部署脚本退出，不会自动停止它。

1. 记录旧服务启动参数、Nginx 文件和端口；备份原目录与配置。
2. 在独立测试主机或临时 HTTPS 域名验证候选版本，完成 TEST_MATRIX 中对应测试。
3. 安排切换时关闭旧服务、禁用发生冲突的旧 Nginx server block。保留文件以便回滚。
4. 执行新部署，核查 `systemctl status zeydrop`、`nginx -t`、实际浏览器两端 WSS / 直连及完整文件校验。
5. 若失败，停止新服务并恢复原 Nginx、unit 与活动目录。不要同时启用两个竞争同域名 / 端口的配置。

旧的短房间号、cookie peer ID 和 LAN_MODE 行为不迁移为新会话凭证。旧页面协议与 v2 不兼容；要求双方刷新到同一新版。

## 回滚

`sudo bash scripts/rollback.sh` 切换到 `/opt/zeydrop/previous` 记录的上一版静态资源和信令实现，然后重启服务。它用于相同部署模板的版本回滚；**不负责恢复被手动修改的域名、TLS、systemd 或 Nginx 配置**。涉及配置变更应恢复前述备份。

发布后不立即删除旧 release，以便回滚。Service Worker 不在传输中强制激活；提示用户传输结束后关闭本站所有标签，再打开使新 shell 生效。回滚也要检查 PWA shell 版本。

## 发布前门槛

- 全部自动化检查通过；审查对应 commit，不能使用旧提交的绿灯。
- 实机验证 HTTPS/WSS、证书续期、systemd 重启、配置迁移和回滚。
- 跨宽带 / 蜂窝 / 运营商 / IPv6 / 严格 NAT 测试，记录失败及原因。
- 对照两个方向传输、拒绝 / 暂停 / 取消 / 文件校验、大文件能力和后台切换。
- 浏览器 Safari / iOS 无流式文件 picker 时，超过 64 MiB 必须拒绝；不能以模拟 picker 测试替代实际授权和保存验证。
