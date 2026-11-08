# 手机二维码与文字窗口后续验收

记录日期：2026-11-07（America/Los_Angeles）。基线b46888536766ced566dc0aadc2592b69716842b3 / CI71。继续使用现有开发分支与Draft PR #2，不合并main、不部署用户主机、不更名。

## 本轮实际修改

- client/styles.css、index.html：修复390px实图中QR操作行换行、底部隐私说明位于预览后而需滚动的问题；操作仍至少44px，说明移至预览之前，短屏内滚动。
- client/scripts/ui.js：Canvas getContext返回null/throw及清理/绘制/导出失败不再让打开/输入/关闭抛错；先隐藏旧预览、撤下载链接，必要时清零backing store，能力失败明确提示并禁用生成。恢复需新显式生成，不转到外部服务。
- 同文件：修复收到文字转QR后经历persisted pagehide/pageshow，原收文active被留在隐藏窗而新消息永远排队的问题。仅保存同一页已有原文字Dialog引用，返回一次性清除并交给单模态仲裁；QR内容/图片仍清空，不恢复身份或自动发送/文件授权。
- tests/text-tools-ui.test.cjs：Canvas新增4项先红后绿；缓存返回新增4项（先红3项、1项对照），合计17项工具控制器。DOM/画布调度双不冒充原生。
- tests/text-qr-layout-browser.cjs：三引擎各五尺寸×深浅，真实几何与elementFromPoint、44px单行操作、390/桌面首屏提示与保存、320首屏隐私与关闭、短屏及横屏滚动可达；原始画布和下载PNG经独立ZBar解码。输出qr-layout-*，不混入21张主截图包。
- tests/text-qr-browser.cjs：已核码的实际非relay UDP连接期间，针对单个输出canvas注入null/throw，必须退役旧图/链接，可编辑清空关闭且原连接保持；恢复原方法后实际重新编码并独立解码。它是明确的受控资源故障，不是物理内存耗尽实验。
- CI在mDNS前执行三引擎布局，提前在nginx阶段安装测试用libzbar0；原有完整文件、恢复、六组合及安全断言不移除。

## 本地已经验证

435/435 Node，0失败/跳过；构建revision7cdefdd3de674966、重复构建/check-build、shell/diff与两侧audit0。独立只读复核相关67项及25项均通过，但重叠集不累计成额外测试数量。

本轮实际再次尝试系统Chromium，仍在启动时遇到socket权限runtime-operation-denied；未把本地语法或几何推导记为浏览器通过。新增原生几何/故障/解码和当前21张截图由此提交的GitHub Runner执行；最终结果、运行ID与精确候选包校验记录于PR #2，不能沿用CI71旧运行码绿灯。

## 截图和可接手状态

真实原图可从对应CI的zeydrop-text-qr-evidence取得，新增布局证据在zeydrop-local-ui-evidence的qr-layout-*。PNG可独立预览，不要求把ZIP当图片打开。手机为模拟视口，Linux WebKit不是Safari硬件。截图使用构建后的真实页面；成功连接来自原生路径和人工核码，不通过mock连接制作效果图。

WebSocket/HTTP/ICE/文件传输协议未修改。现有实现仍只通过RTCDataChannel传文件与文字，不新增服务器文件中转；静态页面、信令、心跳及STUN仍有流量。实际WAN/NAT/IPv6/CGNAT/切网、手机/Safari/权限/镜头、独立主机部署回滚和长时容量仍是外部验收项；本轮BFCache证明只到生产控制器受控生命周期事件。
