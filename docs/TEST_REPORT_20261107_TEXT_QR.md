# 文本、真实界面与Direct-only复核

记录：2026-11-08 UTC（2026-11-07美国太平洋时间）。基线2e611ea，开发分支/PR #2，main不改，仓库更名仍由用户手动执行。

## 已修改

- client/index.html、scripts/ui.js、styles.css：主页本地文字二维码工具，发送与收到文字转二维码、PNG保存、精确UTF-8容量、变更撤旧码与关闭清空；发送改为纯文本textarea并保留失败草稿。单活动模态/排队及20条待查看文字，手机按钮换行。
- client/scripts/transfer.js：修复4096换行/控制字符序列化超8192后误断链；精确text字段/1..4096单位/32768解析围栏，其他控制仍8192。发送布尔结果和双向原有直连/核码门保持。
- tests/text-protocol.test.cjs：8项安全门、大小、Unicode/HTML字面与JSON转义重文本、发送异常回归。
- tests/text-tools-ui.test.cjs：9项生产UI状态逻辑回归，覆盖异步旧结果、容量/不完整Unicode、清理、单活动模态和20条收文队列；DOM调度双不是原生渲染证据。
- tests/text-qr-browser.cjs、decode-qr.cjs及CI：三引擎真实文字/文件直传、原生QR像素与本机ZBar独立解码、截图和网络观察，待Runner执行。

工具使用原有本地qrcode依赖，不新增应用依赖。byte模式/M纠错/4模块静区/512px PNG，最多800 UTF-8字节，不改写URL或截断；不完整Unicode明确拒绝，不替换。二维码包含明文；关闭工具清空，不持久保存，发送/接收原窗仍按用户选择保留其内容。

## 当前验证

本地427/427（0失败/跳过）与构建/check-build通过。原始记录为本机text-qr-node-test.log。新增8项先红后绿、联合hello/latechannel/transfer/path36/36通过。本地系统Chromium实试仍在启动时因process_singleton socket EPERM中止，未算浏览器成功。原生三引擎、独立解码、真实截图、网络正文观察将由新GitHub Runner执行；结果未取得前维持待验。

## 正文路线复核

实际源码：server/index.js拒绝binary，只转发同房有界SDP/ICE；deployment/nginx.conf静态仅GET/HEAD、1KiB body上限，唯一WSS代理没有上传服务。network.js只配STUN，getStats选中已知非relay后且双方人工核码才允许传输。transfer.js的文件块/元信息/哈希/恢复/文字经sendJSON或_send抵达RTCDataChannel.send，无HTTP/WSS回退。vendor.js本地打包二维码生成器，无外部QR请求。

既有CI68原始证据在同机/STUN关闭场景记录Chromium68条/1851B和Firefox11条/1342B信令，未观察文件正文；此为既有运行范围，不能代替新改动或真实公网证据。

产品实现不上传、存储或代理正文，并不意味着服务器总流量为零：网页、信令、心跳及STUN会产生少量流量。信令白名单不是语义DLP，攻击者还可以发送被拒绝HTTP请求体或在受限SDP中隐蔽编码，因此不宣传服务器物理上绝不可能收到任意正文字节。生产主机与真实WAN的抓包/计数和文件独立SHA仍须Issue #4实测。

## 未完成的验收

整体仍为未发布开发候选，界面进入实际代码但不等于全部产品/设计验收。真实跨运营商/CGNAT/IPv6/严格防火墙/切网、Android/iOS/macOS Safari/真实文件保存与资源限制、用户独立主机TLS/证书/systemd/升级回滚、12小时/多日与生产容量仍待实测；Issue #4/#5保持开放、PR保持Draft、main/正式环境未改。二维码图像可被真实手机扫描，但CI解码不代表所有手机镜头/屏幕/光照可用。
