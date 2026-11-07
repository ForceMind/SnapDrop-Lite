# 工程验收报告 · 2026-11-06

> 历史阶段报告；当前运行代码与CI52最终验收见 [TEST_REPORT_20261107](TEST_REPORT_20261107.md)。下文“待CI”等属于对应旧阶段，不代表当前状态。

## 验证版本与结论

**代码848d16c1bd1e419ab30c543f8afa0eb0c0c2ff1e / revision dd492385685e4a1f，CI47全通过。** 仓库仍为ForceMind/SnapDrop-Lite，分支feat/direct-first-workspace-20261019、PR2保持Draft；main/用户电脑/真实服务器未修改，更名由用户最后手动完成。版本0.3.0-dev.1仅供隔离部署测试，不是正式RC或稳定Release。

[CI47](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42216448334)，测试临时合并树5a097e78938c0fee694812cd8ff0f97b8b7c5659，与代码分支文件树相同；这不是合并main。本轮从0c7bf14/77项开始，新增62项Node回归，最终139项。

## 实际通过范围

| 项目 | 结果与边界 |
|---|---|
| 单元/协议/WS/发布边界 | 139/139，生产依赖审计、shell、可重复构建、资源引用通过 |
| 静态发布 | 20项批准输入快照；额外.env/notes不发布、不影响revision；批准文件/父目录symlink或特殊文件拒绝，验证失败保留旧构建；无.git候选可构建 |
| 实际临时Nginx HTTPS/WSS | 安全头、重定向、Origin、双客户端配对、上传拒绝；存在的.env/.git/嵌套/编码/query路径404，.well-known示例200 |
| Chromium/Firefox文件 | Chrome1GiB、Firefox100MiB、0B/中文特殊文件名、独立磁盘SHA-256、配额失败、同页重连恢复 |
| OPFS恢复 | 原生Worker/OPFS、并发checkpoint/erase、双标签锁、跨刷新前缀与最终哈希；真实存储权限/驱逐待测 |
| UI | WebKit手机布局、邀请/二维码、键盘/隐藏控件焦点循环、复制不可用、转义名称、身份前文件选择禁用、诊断导出 |
| 严格六组合 | C-C、F-F、C-F、C-W、F-W、W-W全部双向约1MiB文件，实际selected非relay/安全码/接收同意/独立下载SHA-256 |
| 独立源码包 | 167文件逐项hash/权限、实际重装依赖、139测试、无.git重建通过；Node24本地与Node22 CI tar.gz逐字节一致 |
| 真实硬件/公网/主机 | 均未验收 |

所有自动浏览器测试同主机、STUN关闭，文件picker选择由夹具提供；不证明真实系统picker授权、NAT成功率或IPv6路径。selected地址族未公开，明确不推断IPv4/IPv6。

## 已修复的具体问题

旧异步发送/前缀哈希/错误、ICE代次与空candidate元数据；OPFS锁前旧元数据/Worker竞争；本机前缀准备断线报offset0；旧peer失败未撤销新owner；双向ID冲突泄漏writer/64MiB预算；空MIME、配额处理。已保存对应旧源码失败回归。身份、实际非relay路径和每文件接收授权保持。

公开发布风险另有隔离复现：旧9ad构建把未追踪.env和笔记复制到dist并改变revision。现明确公共输入清单、快照读/写/哈希与vendor打包，另由Nginx独立拒绝隐藏路径。测试使用合成文件，没有观察到真实用户秘密泄漏。

部署/回滚锁覆盖npm/install/build/切换，规范权限与canonical Node，真实WS hello就绪和失败恢复有隔离夹具；不是实际systemd验收。响应式工作台、近期有界速度/ETA、复制反馈、准确本机暂存文案与高级诊断已进入真实源码。

## WebKit对照与性能观察

默认原生环境中，C-C/F-F/C-F通过，含WebKit三个组合失败；candidate API调用resolve且mDNS UUID-v4格式匹配，远端候选计数仍0。gathered SDP控制仍失败，test-only Chromium禁mDNS控制成功。准备并预检D-Bus/Avahi/NSS后，同默认浏览器策略的原生六组合和严格产品六组合全部通过。结果支持此前Linux Runner的系统mDNS环境解释，不代表真实Safari已验收。产品与严格矩阵未关闭mDNS、重写地址、接受未知路径或增加relay。

C-W EOC模式实际emittedEndMarkers=[0,0]，不能声称该实验已验证/排除空EOC假设；运行时EOC另有Node/WS回归。Playwright1.64.1：Chromium156.0.8078.4、Firefox157.0、Linux WebKit27.2。

CI47 Chrome1GiB用例81538ms，独立磁盘SHA-256一致；峰值应用接收队列262225B，Firefox163922B。队列计数不是浏览器RSS，耗时不是公网吞吐保证。测试观察窗口Chrome WS40条/1431B、Firefox8条/1297B，未见文件正文；不能宣称服务器总流量为零。此前CI45约130秒，差异也表明同机用例不能用作生产速度承诺。

## 下载与完整性

[CI47源码/构建候选](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42216448334/artifacts/13500684979)，保留至2026-11-13，包含tar.gz、校验与schema2逐文件manifest。

```text
71ee5a318084206013aac2865653eb2a4c21adf998c3565427ad2ffece0d82e2  zeydrop-candidate.tar.gz
```

来源848d16c，CI manifest记录临时合并树5a097e7，两端归档相同。包在浏览器前生成，必须结合该run最终结果；本次run全绿。有限秘密模式扫描不保证所有秘密不存在，SHA-256不是签名。

原始证据已永久归档docs/evidence/ci47-*.json；GitHub证据附件13502167504。独立包复验见candidate-extraction-848d16c-20261106.json。旧CI45/46证据保留历史，不替代当前发布边界的CI47验证。

## 剩余外部验收

Issue4：真实跨宽带/蜂窝/运营商、IPv6/NAT64/CGNAT/严格NAT、切网/后台冻结；Issue5：真实macOS/iOS Safari；另有Windows Edge、Android、实际磁盘/配额/驱逐/触控/屏幕阅读器/PWA。独立测试主机的可信TLS/续期、systemd、迁移/重启/失败恢复/回滚未演练，按REAL_DEVICE_TESTING、DEPLOYMENT、RELEASE_GATES逐项记录。

跨刷新发送队列持久化、显式同意LAN自动发现仍未实现；同页队列已支持。OPFS24小时后过期，清理仅站点运行时尽力执行；无法保证恢复或关闭标签后后台删除。无法选中非relay路径时明确失败，不回退TURN/DERP/HTTP/WS文件代理。以上外部项补齐前继续Draft，不自动合并main、生产部署或创建稳定Release。

## 持续研发：失败重试、发送清单与容量短基线（新CI待运行）

以a59204e/CI48重新同步后，新增失败任务15分钟/30File引用的手动重试、暂停并保留后续队列、held清空与Blob屏障；自愿本机跨刷新发送清单（100项/128KiB/固定24小时），256KiB分块完整SHA-256重选、Web Locks+revision CAS、新配对/人工核码/手动发送、最终成功逐项移除。新增实际UI异步代次与撤回存储同意保护。

修复hello分配会话容量的并发竞态和满表拒绝合法恢复。新增隔离进程server-load工具，64/256/1000连接短基线、四类协议限额、资源回收以及RSS/CPU口径见SERVER_PERFORMANCE；原始去敏结果包含源码哈希。没有以计数器归零推断RSS归零，没有以256连接推断生产SLA。

本地177/177 Node通过（旧139+协议8+store14+UI10+capacity3+load3），生产依赖审计0已知漏洞、可重复构建/引用/PWA、shell语法、diff检查通过。本地实际尝试浏览器，系统Chromium因socket EPERM被执行环境阻断；此处不标浏览器通过。新增真实浏览器发送清单、失败重试及原有1GiB/100MiB/六组合/HTTPS检查须对应新head的GitHub CI验收。真实Safari/移动/跨运营商/生产主机与长期soak仍开放。
