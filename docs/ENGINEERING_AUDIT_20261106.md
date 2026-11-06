# 工程基线与本轮修复审计 · 2026-11-06

来源：重新连接 GitHub 后核验仓库 ID 1255852392（仍为 ForceMind/SnapDrop-Lite）、默认 main、四个分支、开放 PR #2/#3、开放 Issue #4/#5 和 Actions。交接 25b7f39 已不是 head；启动时开发 head 为 `0c7bf144d7b6f2e2487f624e3d3e401e213b9e81`。main 保持 `2b4f75c`，未修改。PR #2 为 Draft，描述仍引用较早的 CI #16，不能据此判断当前能力。

CI #42（42204473272）77 项 Node、HTTPS/WSS、Chromium 1 GiB、Firefox 100 MiB、Chromium↔Firefox、OPFS 跨刷新、WebKit UI 及开发归档通过，但 Chromium↔WebKit 无 selected pair，整套失败。启动时 CI #43 后来在浏览器安装阶段取消，没有新增浏览器成功证据。

| 分类 | 真实基线与本轮处理 |
|---|---|
| 已实现且已有证据 | 安全配对/授权、selected 非 relay 路径、分块/背压/完整哈希、同页及实验性 OPFS 跨刷新恢复、Chromium/Firefox 文件闭环、临时 Nginx TLS/WSS；历史同机 CI 不能替代 WAN |
| 已实现但未充分验证 | Safari/WebKit 文件能力、12 小时真实持续会话、移动后台/切网、真实保存 picker、实际 systemd 主机部署/回滚 |
| 尚未实现 | 跨刷新发送队列持久化、显式同意的 LAN 自动发现；浏览器 Web MVP 无原生端口映射能力 |
| 数据完整性缺陷 | 旧异步 File 读取在同 peer 恢复后仍可重复发送；旧前缀哈希/错误可影响新代次。新回归在旧源码上失败，现增加发送代次与过期错误隔离 |
| OPFS 数据损坏风险 | 旧元数据读于锁前，可能把 32768 B 断点截为16384 B；异步 erase/checkpoint/finish 会互相覆盖。请求串行、锁内重读、完成记录写入前不释放数据锁；五项旧版失败回归已通过 |
| 其他核心缺陷 | 空 MIME 导致两端恢复元信息不一致；checkpoint 配额失败误关闭整个 peer。现规范 MIME，存储失败只取消文件 |
| 信令/身份风险 | 新代候选可能先于新 SDP，旧代候选/结束标记不能应用至当前 ICE。新增 ufrag 匹配、64 条/10秒待匹配队列、保留浏览器原始空 candidate 结束标记；不合成 null 全局结束标记，不降低路径核验 |
| 包与部署风险 | 旧打包会收进非追踪文件、.env.production、符号链接并错误标为HEAD。现仅干净追踪源码+核验构建、敏感路径/模式检查、逐文件清单；回滚失败恢复原指针并保留标记、共享锁与真实WS hello检查 |
| 性能瓶颈 | 前缀校验仍需额外读取原文件；采用分块、ACK和有界队列，不声称覆盖弱手机CPU/整体内存峰值；未通过缓存整个大文件优化 |
| 浏览器阻断 | Issue #5 未解决。六组合严格产品传输矩阵，另用原生 RTC、完整收集 SDP、标准 EOC、隔离 mDNS 控制区分原因；成功 addIceCandidate 不等于原生栈实际选中路径 |
| 云端可完成 | 上述修复、回归、六组合与控制实验、候选包重建/校验、有限秘密扫描、文档/双语 README、部署故障夹具 |
| 必须外部实测 | Issue #4 跨运营商/IPv6/NAT64/严格 NAT、真实移动与Safari、真实文件权限/磁盘/PWA、用户授权的主机/TLS/systemd/续期/回滚 |

本地启动复验为77/77；整合修复后本地105/105，构建和引用复验通过。所有浏览器新场景需以本轮新提交 CI 为准，不能沿用旧绿灯。本地系统依赖安装无法取得 root，浏览器 CDN 下载返回无效归档；未请求用户本机或服务器权限，浏览器验证交由 GitHub CI。

W3C 标准参考：[addIceCandidate / icecandidate](https://w3c.github.io/webrtc-pc/) 区分 generation 的空 candidate 对象与 null gathering 事件。本轮保留元数据、字段/房间白名单和 relay 拦截，不重写浏览器 ICE/NAT 协议。

未操作用户电脑、真实服务器、生产环境或域名；未合并 main、强推、重写历史、创建新仓库或定时任务。手动更名继续留给用户。正式发布门槛仍在 RELEASE_GATES，未满足时只能交付透明标注的隔离测试开发包。
