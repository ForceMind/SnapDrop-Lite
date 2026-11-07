# Zeydrop 当前工程状态

记录：2026-11-07 UTC。0.3.0-dev.1未发布开发候选；开发分支feat/direct-first-workspace-20261019，[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 当前结论

本轮在上述开发分支继续实现实时传输/恢复前缀SHA Worker、已完成暂存复验Worker，以及自然会话过期和写入后哈希失败的数据保留修复。后续又修复取消时清理异常和本机暂存面板的迟到验证/URL引用。**最新清理改动尚待其对应提交完整CI、浏览器矩阵和候选复验，不能沿用e2a2088或更早运行的结果。** 既有CI绿灯不能覆盖新改动。

状态式Worker基线e2a2088已完成[CI59全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42367663439)，324/324 Node及原生三引擎Worker、1GiB/100MiB、六组合、OPFS/离线PWA均通过，实际候选已独立解压重装/无Git重建。见[本轮报告](TEST_REPORT_20261107_STREAM_HASH.md)。对应本地检查记录：324/324 Node通过，构建8283668696e877e0及重复构建/脚本语法通过，根目录与server依赖audit均0漏洞。12项异步传输/故障回归已通过；该数量对应e2a2088，后续新增取消清理/UI回归与原生OPFS Worker故障恢复仍需另验，不是最新提交最终CI结果。本地浏览器启动受socket EPERM限制，未将其标为通过。

既有基线[CI57全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421)，运行代码172adc8ae2bfc9dd577f56fb92c103a4ad64e78b，revision10c5794070ac6a1b：285/285 Node、完整audit、构建/PWA、临时HTTPS/WSS、三引擎清单/Worker、Chromium1GiB/Firefox100MiB、原生OPFS/跨刷新、严格六组合、离线PWA仿真与UI检查通过。[完整证据及限制](TEST_REPORT_20261107_FINAL.md)。

可交付独立测试主机部署验证的开发候选，不是正式RC/稳定版。main未合并、生产和用户电脑未操作；仓库最后由用户手动更名，不假定拥有zeydrop.com。

后续清理代码本地339/339 Node、revision25c4bc95c5f8c577、重复构建及脚本检查通过；其完整CI与原生OPFS故障组合尚待新提交执行。

## 既有云端证据及本轮实现

| 范围 | 行为与边界 |
|---|---|
| 配对/直连 | 128bit双人邀请、锁定身份/TTL、精确Origin/信令白名单；selected非relay、DTLS人工核码和接收同意；无文件中继 |
| 文件 | 分块/背压/写入ACK、完整SHA、0B/多文件/暂停/取消/手动失败重试；完成含sink结束及双方哈希，不按100%进度判断 |
| 恢复 | 同页120秒、用户主动选择OPFS断点和发送清单；新路径/身份确认、完整重选/前缀校验、无自动历史文件绑定 |
| 数据保护 | Issue #6修复并通过：原checkpoint错误保留、旧write完整记账后park、过期交接和迟到finish按精确state清理、原生Worker失败释放active；物理I/O仍有下述限制 |
| 资源/Worker | 清单全量SHA既有Worker通过；实时/前缀现已接入状态式Worker（4句柄、每句柄4操作、256KiB分块/30秒操作截止），本轮完整CI待验；前缀共享4未结束I/O、恢复RPC32项保留 |
| UI/PWA | 深浅主题可读暂存面板/placeholder/焦点，真实列表组件和键盘测试；CI57版本SW/缓存/Worker离线仿真通过，非真机生命周期证明 |
| 性能 | owning-browser RSS/PSS/CPU覆盖报告、实际慢读者128KiB阈值与永久不读者真实30秒回收；不是整机指标或生产容量 |
| 交付 | 公共输入当前25项；既有23项基线的版本缓存/隐藏路径、源码manifest/有限秘密扫描、独立246文件解压/重装285测试/无Git重建已验，新候选须另验 |

本轮新增：自然会话到期/永久关闭保留自愿本机检查点，不保留旧身份或held授权；Worker在写入后失败时仅releaseCommitted关闭精确句柄，保留旧offset/SHA，不发布未验证尾部。已完成本机文件复验使用全文件Worker并核对长度/摘要，验证后才提供保存。发送侧本机前缀读取/Worker失败现在只取消该发送文件，不破坏同时接收的另一文件。进一步修复取消/held/准备阶段abort的同步或异步失败：消费异常并显示固定清理失败提示，不泄露原生错误或影响新state。本机暂存面板按代次管理各自AbortController、下载URL和撤销计时器；列表切换释放未点击URL，已点击URL保留有界下载启动宽限，删除/pagehide释放；迟到结果不能向新列表发布链接。新回归及原生浏览器验证结果待本轮报告。

小时本机信令已实际通过：3600秒、64连接/32房、15360条全部收齐、472次原身份恢复；真实121.902秒后自动清零。原b19f工具/新00f guard短测边界及RSS观察增长见SERVER_SOAK，不宣称无泄漏、生产容量或公网成功率。

用户文件正文不经HTTP/WSS，服务器仍有网页/信令/心跳/STUN相关少量流量。已提交断点的故障保留不等于备份保证；主动取消当前文件、手动删除及确证完整性失配保持对应策略。native close或restore/park挂起时不能保证物理锁立即释放。

## 精确已验源码候选

最近完整已验为[CI59 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42367663439/artifacts/13571604402)，运行代码e2a2088/revision8283668696e877e0，288文件，保留7天；tar SHA-256为dcc30529c67fc0c6e6915a2e7fb65987bd9f31c383f094188b5f5b0c732dbb5b。外部manifest临时合并来源与324项独立重装/无Git复验见TEST_REPORT_20261107_STREAM_HASH及evidence/stream-hash-ci59-candidate.json。最新后续清理改动须另验。

后续文档候选以自身manifest/Actions artifact为准；PR保留最新下载/校验，不能将上面的归档哈希用于不同文件包。main仍是旧版，部署不要仅依赖main或移动分支名。

## 未完成与验收阻断

| 项目 | 真实状态 |
|---|---|
| WAN/NAT/IPv6/双栈/严格防火墙/切网 | 正式RC阻断；需两个真实设备与链路、selected非relay、独立SHA和服务端流量证据，Issue #4 |
| Edge/移动/macOS与iOS Safari/真实picker/磁盘/驱逐/后台/PWA升级/无障碍 | 正式RC阻断；Linux WebKit不是Safari硬件，Issue #5；WK哈希基准只有8MiB回退 |
| 独立主机TLS/证书续期/WSS/systemd/升级迁移/重启回滚 | 正式RC阻断；需用户自行授权测试主机，当前只是隔离夹具 |
| 12小时/多日、真实生产并发SLA、弱移动设备资源 | 未验证；小时本机信令和短1000连接不替代 |
| 本轮状态式哈希Worker及检查点修复验收 | 实现已接入，尚待本提交完整CI、三引擎原生Worker/文件矩阵、无Git候选复验；不得沿用CI57结论 |
| 显式授权LAN发现 | 未实现，非Web MVP硬前提；邀请/二维码可用，不以相同公网IP冒充可信邻居 |

下一步先完成本轮完整CI与候选复验，修复实际失败；真实网络/设备/主机按REAL_DEVICE_TESTING另行采集证据。发布门槛不因CI成功自动打勾，不转Ready/合并main。历史报告、失败JSON和Git提交均保留。
