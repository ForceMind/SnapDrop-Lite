# 工程验收报告 · 2026-11-06

## 对应版本

- 仓库仍为 ForceMind/SnapDrop-Lite，用户最后手动更名；main未改。
- 本报告的代码基线是 `cfdda0c4ad333e32eaaf84cab82fdee9b6d33056`，revision `7a735397dd67d8d1`，版本0.3.0-dev.1。
- GitHub CI #45：<https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42212721830>，测试用合并提交 `c1999b2b7c13ec725db95dfa661ff50fbebac42e` 的文件树与代码分支一致。不是已合并main。
- 本报告为开发候选工程证据，不是正式RC、生产部署、真实WAN或Safari硬件验收。

## 已完成代码与回归

本轮从0c7bf14重新审计，新增57项Node测试：77→105→134。修复发送/ICE代次、过期异步回调、本地断点锁内元数据与Worker事务、前缀准备中断、替代peer状态所有权、双向ID冲突和空MIME；所有文件仍仅经DataChannel，接收授权、身份核对、selected非relay与完整SHA-256门槛保持。

UI补充可见/启用控件焦点循环、剪贴板不可用时保留文本、准确的过期与清理说明，近期有界吞吐/ETA。发布路径限制干净追踪源码、核验构建、有限秘密扫描、逐文件清单；部署锁覆盖npm/build、修复严格umask权限、canonical Node及回滚事务/WS hello。

## 验证状态

| 项目 | 结论与边界 |
|---|---|
| 本地134项Node、shell与构建 | 通过；云端Node24.22.1，revision与重复构建一致 |
| CI45 Node/审计/构建/Nginx/临时HTTPS-WSS | 通过；Node22.23.4，实际双WS客户端，不是双硬件 |
| 原先CI44安装阻断 | 18分钟耗尽于APT181包第39项；现使用官方HTTPS源，保留签名策略，三套浏览器安装与缓存通过 |
| Chromium↔Firefox、原生OPFS与跨刷新恢复 | 通过，原始脱敏JSON已归档；Chromium真实并发checkpoint/erase回归通过 |
| 大文件/UI与六组合严格互传 | 通过：Chrome1GiB/Firefox100MiB，WebKit新版UI与六组合双向独立SHA-256 |
| 原生/mDNS对照 | 默认环境WebKit三组合失败；Avahi/NSS预检后同默认策略六组合均成功，见下文 |
| 独立源码候选解压 | 154文件哈希/权限通过，无.git；实际重新安装依赖，134项测试及重建通过 |
| 本地/CI归档跨Node可复现性 | 两端tar.gz逐字节相同；CI的ZIP封装与manifest.commit可不同 |
| 用户主机/生产/真实设备 | 未操作、未测 |

## WebKit环境结论与证据限制

修复前，候选API调用resolve且UUID-v4 mDNS格式匹配，但WebKit远端candidate计数0、无selected pair。浏览器默认原生控制中的C-C、F-F、C-F成功，含WebKit三个组合失败；gathered SDP模式仍失败。test-only Chromium禁mDNS控制成功。安装并验证Linux D-Bus/Avahi/NSS后，同一默认浏览器策略的原生六组合及严格产品六组合全部通过，支持此前阻断与此Runner的系统mDNS环境有关。没有在产品或严格矩阵关闭mDNS、改写候选地址或降低授权/selected路径门槛。

C-W的trickle-end-marker控制实际emittedEndMarkers为[0,0]，不能声称该实验已验证空EOC假设；运行时EOC边界另有Node/WS回归。Safari真机仍待测。浏览器版本：Chromium156.0.8078.4、Firefox157.0、Linux WebKit27.2，Playwright1.64.1。

Chrome1GiB测试129897ms，独立磁盘SHA-256一致，观察到的峰值接收队列163922B；这不是整个浏览器RSS或弱手机内存证据，也不是公网吞吐承诺。测试窗口Chrome WS61条/1746B、Firefox10条/1327B，均未见正文，不能据此宣称服务器总流量为零。selected地址族未公开，不能当作IPv4/IPv6实测。

原始JSON与汇总见 evidence/ci45-*.json，GitHub证据附件13500062369。

## 可下载候选

[CI45源码/构建候选附件](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42212721830/artifacts/13499876562)，保留至2026-11-13。包含tar.gz、SHA-256及schema2逐文件manifest。

`zeydrop-candidate.tar.gz` SHA-256：

```text
e07638ba97b232f01add955b6a6adbf3d5e5ccec231d4ec042c88235def679f9
```

来源cfdda0c；CI manifest记录其临时合并提交c1999b2，文件树/归档相同。验证细节见 `evidence/candidate-extraction-cfdd-20261106.json`。附件在浏览器安装前生成；附件存在不意味着浏览器、WAN或正式发布门槛通过。有限模式扫描不是秘密完全不存在的证明，SHA-256不是签名。

## 外部阻断

Issue4：真实不同运营商/蜂窝/IPv6/NAT64/CGNAT/严格NAT、切网/后台冻结、macOS/iOS Safari/Android/Windows Edge、实际picker/磁盘/存储驱逐/PWA。真实测试主机的可信TLS、证书续期、systemd、迁移与失败回滚未演练。步骤和证据模板见 REAL_DEVICE_TESTING、DEPLOYMENT 和 RELEASE_GATES。

同页120秒与接收方自愿OPFS恢复已实现，跨刷新发送队列持久化、显式同意LAN自动发现尚未实现。不能保证所有NAT直连、浏览器存储恢复或关闭所有标签后后台删除。未加入TURN/DERP/HTTP/WS文件代理。
