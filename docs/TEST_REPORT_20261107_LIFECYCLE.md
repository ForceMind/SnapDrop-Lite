# Zeydrop ICE、暂存删除与升级生命周期验收

记录：2026-11-07 UTC。本轮从开发分支 `feat/direct-first-workspace-20261019` 的 `30b66f1e27948ddec3a5a3b7352da580d07fffde` 继续；main 未改，PR #2 保持 Draft，未操作生产或用户电脑。前轮运行代码 `26aed41` / revision `06d9143aa3bbb8fe` 已由 [CI65](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42388784628) 完整验证，详见 TEST_REPORT_20261107_PROCESS_RECOVERY；文档头30b66f1 的 [CI66](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42389964683) 亦已完整通过，最终候选归档核验见 PR #2；这些结果不认证本轮新修改。

## 当前完整验收（CI68）

[CI68](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529)全套成功，运行代码3cdbeae8e3c931c4c83f68c2510c4d321fec7ccb、revisionc75833843f0b324f、job128512893992。已读最终真实日志：410通过、0失败、0跳过；两侧audit、重复构建、临时HTTPS/WSS/Nginx、三引擎Worker/清单、Chromium1GiB/Firefox100MiB、严格六组合双向SHA、OPFS/跨刷新/故障/整进程恢复、原生PWA升级回滚、离线Worker和UI全部通过。

原始[证据artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529/artifacts/13589500135)ZIP2210776字节，SHA-256 223615e811da4968ac9d425cbdcd7fd8402e72b38b2bb46df1683fcd21679a42，实际下载CRC/安全成员核验；32份JSON永久归档为evidence/ci68-*，汇总ci68-workflow.json。单次Chromium1GiB时段145064ms、Firefox100MiB为13144ms，不构成受控性能比较、公网速度或生产SLA。

PWA当前A=c75833843f0b324f/B=9bb81e9863ff7e6f，真实失败安装保留A、旧双/单客户端期间等待、全关闭后自然升级与回滚；每阶段27项缓存逐字节一致，三个Worker同版本离线启动、SHA与64KiB本机检查点均保留，无历史文件自动绑定。原生暂存删除三场景也再通过：16KiB新前缀/metadata原样、争用准确拒绝、未重载即重新取得0B控制/数据锁；包含受控计时门和初始时钟推进，非自然24h老化或真实磁盘故障。

## 当前补充：完整遗留release的只读重试（CI68已验证）

新增scripts/verify-prepared-release.cjs后，构建revision为c75833843f0b324f，本地410/410（0失败/跳过）、构建/check-build/shell/diff通过。校验器从新构建、三个server入口/包文件和整份锁定server/node_modules推导完整目录/文件集合，包括空目录；固定句柄分片SHA、类型/模式/有效用户所有权、无符号/硬链接/特殊文件、枚举/大小/深度限制及最后元数据围栏全部一致才复用。校验器不执行release代码、不联网、不修复，不复制/改权限/删除既有release。读取可能更新atime，元数据检查不是原子文件系统快照。

新增10项（相关24项）通过；旧c4脚本两个完整shell重试用例均因Release already exists失败，修复后首装失败及升级失败的完整遗留目录可重试，保留inode/owner/mode/size/mtime/ctime/内容。已是current时拒绝并保持真实previous/活动指针/配置；残缺、不一致、不安全目录继续拒绝且保留待检查。没有自动删除或覆盖的权限扩展，也未声称所有失败残留都能自动恢复。见evidence/prepared-release-local-20261107.json；此运行代码已由CI68独立全套410项/原生套件及419文件精确候选核验，未沿用c4绿灯。

## 本轮可复现缺陷与实现状态

| 范围 | 已定位的实际问题 | 本轮处理与当前证据 |
|---|---|---|
| ICE 协商异步归属 | 旧 createOffer 的迟到失败可将新一轮健康 ICE restart 判失败；旧 remote ICE flush 完成可提前终止新 restart，或在当前 SDP 尚未完成时放行路径。 | 已为异步成功/失败出口绑定精确 RTCPeerConnection 与身份/协商代次；旧结果不得修改当前计时器、路径或授权。14项回归通过；同套测试旧源码8失败/6通过。原生边界由夹具延迟，浏览器自身在途操作不可取消；当前代次失败仍按原安全门槛停止。 |
| OPFS 删除/替换 | 过期 orphan 的 listing 快照过时后仍删除新提交记录；手动 erase 在释放旧数据锁与删除文件之间可能与另一 Worker 的替换交错，破坏新记录。 | 本轮加入保留的零字节 `mutation-lock` 原生独占句柄，只围住 start/resume/erase/过期删除重查等短目录变更；每个活动文件仍保留自己的原生数据锁。过期回收在目录锁及短时正文独占句柄内重查当前 metadata/正文，不将先前 listing 当删除授权。新增源码回归12项、相关116项及c4/CI67原生删除三场景通过。 |
| 首次部署活动指针 | GNU readlink -f 可对不存在的最终组件返回成功及非空路径，导致首次成功写出虚假的 previous，失败时 current 指向自身。 | 只有实际存在的有效 current 符号链接才记录 previous；必须解析到合法版本目录并有构建和服务入口，悬空/自身/普通文件/越界指针在配置与服务变更前拒绝。新增 5 项、相关 14 项隔离 shell 回归通过；非真实 systemd 主机部署。 |
| PWA 更新/回滚 | 旧证据只覆盖单版本离线，不覆盖 A/B failed install、waiting、关闭客户端后激活及回滚生命周期。 | 新增真实Service Worker/Cache/OPFS原生组合已集成并通过；验证失败安装保留旧 shell、新版本不强制激活、关闭旧客户端后升级/回滚、三个同版本 Worker 离线启动与暂存保留。c4/CI67原生结果已通过；新增发布校验器之后的3cd/CI68也已通过。 |

短目录 guard 不是文件正文，不含身份、令牌或新的网络能力；不同标签争用取得 guard 时返回 NoModificationAllowedError，不能关闭本页已活动的独立 writer；由用户重试或下次惰性 sweep 再尝试，不增加无限等待。它只协调使用此协议的新 Worker：部署后须结束传输并关闭所有旧标签再打开，不能声称旧 Worker 自动获得新锁协议。原生 close 失败也不能保证锁立即释放。

## 验证状态

本地完整 Node **400/400通过、0失败/跳过**（新增14项ICE、12项暂存删除、5项部署），构建/check-build、shell/diff通过，revision为cc281863f488aa68，两侧audit均0已报告漏洞；见[evidence/lifecycle-local-20261107.json](evidence/lifecycle-local-20261107.json)。该阶段精确c4提交与CI67原生/全套结果已独立验证，后续3cd另由CI68验收。旧部署脚本负向控制为 4 失败/1 通过，重现虚假 previous 与 current 自环；修复后部署 14 项为临时目录的真实脚本加模拟依赖/服务管理器，不读取或更改真实 /opt、/etc，也不证明真实证书续期、systemd 重启或服务器回滚。所有旧 CI 结果仅按其精确版本使用。本轮本地实际浏览器启动再次遇到 socket EPERM，未计为原生通过；新增浏览器组合由实际CI67/CI68验证通过。

[Issue #9](https://github.com/ForceMind/SnapDrop-Lite/issues/9)历史P2为失败部署留下release阻止同版本重试。下节新增只读复用完整目录，未实现不完整目录的自动清理；保留备份和真实状态供人工检查。

## 云端与外部边界

本轮仅推进可复现应用竞态、隔离脚本和浏览器生命周期。Direct-only、selected 非 relay、当前身份安全码与明确接收同意保持必要条件；没有正文服务器端点、TURN/DERP/WS 文件回退。真实 WAN/NAT/IPv6/双栈/移动切网、Safari/移动设备、真实磁盘/驱逐/后台/PWA 体验、独立主机 TLS/systemd/升级回滚继续待验。已通过的原生升级组件也不是 OS 断网、断电、用户主机或跨运营商证明；保持 Draft，未发布正式 RC。

本轮修改为network.js、recovery-worker.js、transfer.js、deploy.sh、CI及相关回归/文档。NoModificationAllowedError提供固定“等待当前存储操作结束后重试”的提示，不暴露原生错误原文。新PWA夹具只在私有复制源码中附加固定CSS注释生成第二个真实构建，不改变产品源码或当前dist；原生结果已由CI67/CI68实际验证。

## c4c7d6e 独立候选及原生PWA证据

运行提交c4c7d6e2f46d8e63f5a996f52332470390386781 / revisioncc281863f488aa68已独立两侧重装400项、无Git重建及29项dist逐字节复验通过，381普通文件（352源码/29构建）。[实际CI67源码artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42407825773/artifacts/13588740051) ZIP933556字节、SHA-256 fd1bba938075a0b3309094b5ff354de06327a4da39e58a227a7d4a09bdeddb43；内部tar915287字节、SHA-256 6cdb32fbffe05065058c6f05ae54aa052af90b48869987195eb6b10ad97faa82，与独立测试归档字节相同。全部成员/权限/大小/摘要/归档边界、实际临时合并5dd584cd7fda1c0102cf97296a27e0b7e5fc1d33的父提交2b4f75c及c4c7d6e/树均核对，不是main合并。见evidence/lifecycle-runtime-extraction.json、lifecycle-ci67-candidate.json。

CI67原生PWA步骤已通过并下载早期JSON：A=cc281863f488aa68，私有CSS注释变体B=59fd33770ed87471；真实503预缓存失败保留A，双/单旧客户端仍控制旧版，全部关闭后才自然激活B，再同样回滚A。三个阶段各27项缓存逐字节核验，三个Worker按对应revision离线启动、完整/状态式SHA一致，64KiB原生OPFS检查点metadata/正文原样保留、没有自动绑定或写入。见evidence/ci67-pwa-upgrade-chromium.json。旧客户端没有被skipWaiting强制替换；离线为浏览器网络仿真，不是移动/已安装PWA/OS体验验收。完整CI67已通过并读取最终日志/JSON（400通过、0失败/跳过），原始32份JSON及汇总见evidence/ci67-*；原始证据ZIP2149334字节，SHA-256 2c60ff7355bd70e85a05541fdd62837ffda6357a69db00d67f9b706f5df22b06。后续部署重试实现仍需自己的新构建/CI。

## 3cdbeae 当前运行候选独立复验

提交3cdbeae8e3c931c4c83f68c2510c4d321fec7ccb / revisionc75833843f0b324f的源包两次字节相同（含manifest/checksum）；419普通文件（390源码/29构建）按精确Git白名单、成员类型/权限/大小/SHA和归一化元数据核验。新目录独立两侧npm ci --ignore-scripts后410/410通过，0失败/跳过；不含.git的重建/check-build/shell通过，29项dist和390项源码仍逐字节/模式一致。见evidence/prepared-release-runtime-extraction.json。

[实际CI68源码artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529/artifacts/13588981140) ZIP989407字节，SHA-256 6fe25037daf92d2ae440c2967686d7d1dd0f1b172c6baf50850d39b63cba658a；内部tar971150字节，SHA-256 870b2032c95f69c89ec2e29ecfbe269f4f11b5a650aac3c385b8e6d4a0b21768，与独立410项/无Git重建的本地归档字节相同。manifest唯一差异为临时PR合并019362a16d7895ff9237bcd805e25759e0de4853，实际Git父提交为原main2b4f75c与3cdbeae，合并树等于head树；不是main被合并。全419成员、ZIP三项/CRC/安全路径、模式/大小/SHA均核对；见evidence/prepared-release-ci68-candidate.json。完整CI68已成功且最终日志与原始JSON均读验；后续纯文档候选使用自己的manifest和校验值，PR保留最终链接，不混用另一包哈希。
