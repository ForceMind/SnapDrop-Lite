# Zeydrop ICE、暂存删除与升级生命周期验收

记录：2026-11-07 UTC。本轮从开发分支 `feat/direct-first-workspace-20261019` 的 `30b66f1e27948ddec3a5a3b7352da580d07fffde` 继续；main 未改，PR #2 保持 Draft，未操作生产或用户电脑。前轮运行代码 `26aed41` / revision `06d9143aa3bbb8fe` 已由 [CI65](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42388784628) 完整验证，详见 TEST_REPORT_20261107_PROCESS_RECOVERY；文档头30b66f1 的 [CI66](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42389964683) 亦已完整通过，最终候选归档核验见 PR #2；这些结果不认证本轮新修改。

## 本轮可复现缺陷与实现状态

| 范围 | 已定位的实际问题 | 本轮处理与当前证据 |
|---|---|---|
| ICE 协商异步归属 | 旧 createOffer 的迟到失败可将新一轮健康 ICE restart 判失败；旧 remote ICE flush 完成可提前终止新 restart，或在当前 SDP 尚未完成时放行路径。 | 已为异步成功/失败出口绑定精确 RTCPeerConnection 与身份/协商代次；旧结果不得修改当前计时器、路径或授权。14项回归通过；同套测试旧源码8失败/6通过。原生边界由夹具延迟，浏览器自身在途操作不可取消；当前代次失败仍按原安全门槛停止。 |
| OPFS 删除/替换 | 过期 orphan 的 listing 快照过时后仍删除新提交记录；手动 erase 在释放旧数据锁与删除文件之间可能与另一 Worker 的替换交错，破坏新记录。 | 本轮加入保留的零字节 `mutation-lock` 原生独占句柄，只围住 start/resume/erase/过期删除重查等短目录变更；每个活动文件仍保留自己的原生数据锁。过期回收在目录锁及短时正文独占句柄内重查当前 metadata/正文，不将先前 listing 当删除授权。新增源码回归 12 项、相关 116 项通过；原生浏览器验证待集成。 |
| 首次部署活动指针 | GNU readlink -f 可对不存在的最终组件返回成功及非空路径，导致首次成功写出虚假的 previous，失败时 current 指向自身。 | 只有实际存在的有效 current 符号链接才记录 previous；必须解析到合法版本目录并有构建和服务入口，悬空/自身/普通文件/越界指针在配置与服务变更前拒绝。新增 5 项、相关 14 项隔离 shell 回归通过；非真实 systemd 主机部署。 |
| PWA 更新/回滚 | 旧证据只覆盖单版本离线，不覆盖 A/B failed install、waiting、关闭客户端后激活及回滚生命周期。 | 新增真实 Service Worker/Cache/OPFS 原生浏览器组合正在集成；验证失败安装保留旧 shell、新版本不强制激活、关闭旧客户端后升级/回滚、三个同版本 Worker 离线启动与暂存保留。原生结果待本轮 CI。 |

短目录 guard 不是文件正文，不含身份、令牌或新的网络能力；不同标签争用取得 guard 时返回 NoModificationAllowedError，不能关闭本页已活动的独立 writer；由用户重试或下次惰性 sweep 再尝试，不增加无限等待。它只协调使用此协议的新 Worker：部署后须结束传输并关闭所有旧标签再打开，不能声称旧 Worker 自动获得新锁协议。原生 close 失败也不能保证锁立即释放。

## 验证状态

本地完整 Node **400/400通过、0失败/跳过**（新增14项ICE、12项暂存删除、5项部署），构建/check-build、shell/diff通过，revision为cc281863f488aa68，两侧audit均0已报告漏洞；见[evidence/lifecycle-local-20261107.json](evidence/lifecycle-local-20261107.json)。精确提交、新CI/原生JSON和候选包仍待后续集成验收，不沿用旧绿灯。旧部署脚本负向控制为 4 失败/1 通过，重现虚假 previous 与 current 自环；修复后部署 14 项为临时目录的真实脚本加模拟依赖/服务管理器，不读取或更改真实 /opt、/etc，也不证明真实证书续期、systemd 重启或服务器回滚。所有旧 CI 结果仅按其精确版本使用。本轮本地实际浏览器启动再次遇到 socket EPERM，未计为原生通过；新增浏览器组合由后续 Runner 验证。

[Issue #9](https://github.com/ForceMind/SnapDrop-Lite/issues/9)仍有已知部署P2：失败部署留下本次已创建 release，同 revision 再部署会因目录已存在而拒绝。安全清理需要可靠确认未被 current/previous 引用及恢复已完成；本轮没有实现自动删除，不将它标为修复，也不建议无条件删除 release。失败时保留备份和真实状态供人工检查。

## 云端与外部边界

本轮仅推进可复现应用竞态、隔离脚本和浏览器生命周期。Direct-only、selected 非 relay、当前身份安全码与明确接收同意保持必要条件；没有正文服务器端点、TURN/DERP/WS 文件回退。真实 WAN/NAT/IPv6/双栈/移动切网、Safari/移动设备、真实磁盘/驱逐/后台/PWA 体验、独立主机 TLS/systemd/升级回滚继续待验。当前原生升级组合即使通过，也不是 OS 断网、断电、用户主机或跨运营商证明；保持 Draft，未发布正式 RC。

本轮修改为network.js、recovery-worker.js、transfer.js、deploy.sh、CI及相关回归/文档。NoModificationAllowedError提供固定“等待当前存储操作结束后重试”的提示，不暴露原生错误原文。新PWA夹具只在私有复制源码中附加固定CSS注释生成第二个真实构建，不改变产品源码或当前dist；原生结果尚待CI。
