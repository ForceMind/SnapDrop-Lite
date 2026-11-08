# 文本、真实界面与Direct-only复核

记录：2026-11-08 UTC（2026-11-07美国太平洋时间）。基线2e611ea，开发分支/PR #2，main不改，仓库更名仍由用户手动执行。

## 已修改

- client/index.html、scripts/ui.js、styles.css：主页本地文字二维码工具，发送与收到文字转二维码、PNG保存、精确UTF-8容量、变更撤旧码与关闭清空；发送改为纯文本textarea并保留失败草稿。单活动模态/排队及20条待查看文字，手机按钮换行。
- client/scripts/transfer.js：修复4096换行/控制字符序列化超8192后误断链；精确text字段/1..4096单位/32768解析围栏，其他控制仍8192。发送布尔结果和双向原有直连/核码门保持。
- tests/text-protocol.test.cjs：8项安全门、大小、Unicode/HTML字面与JSON转义重文本、发送异常回归。
- tests/text-tools-ui.test.cjs：9项生产UI状态逻辑回归，覆盖异步旧结果、容量/不完整Unicode、清理、单活动模态和20条收文队列；DOM调度双不是原生渲染证据。
- tests/text-qr-browser.cjs、decode-qr.cjs及CI：三引擎真实文字/文件直传、原生QR像素与本机ZBar独立解码、截图和网络观察，CI70已实际通过。

工具使用原有本地qrcode依赖，不新增应用依赖。byte模式/M纠错/4模块静区/512px PNG，最多800 UTF-8字节，不改写URL或截断；不完整Unicode明确拒绝，不替换。二维码包含明文；关闭工具清空，不持久保存，发送/接收原窗仍按用户选择保留其内容。

## 当前验证：CI70全套通过

运行代码`033d88beffc1c6b390f378dbb22fc86234b3ea90`，revision`b46de331c87a6628`。[CI70](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42440165523)与job128607487259完整成功，实际最终日志和35份JSON已读并归档`evidence/ci70-*`。

- 本地及CI Node **427/427**（0失败/跳过），两侧audit0、构建/check-build/shell/diff通过。
- 新协议8项先红后绿；UI状态9项通过，内存负控移除结果隔离/模态仲裁/异常Unicode拒绝会分别失败3/2/1项。后者是明确DOM调度双，不冒充原生。
- 原生Chromium/Firefox/Linux WebKit各9组流程全部通过：真实selected UDP非relay/双方核码、文字原样接收/4096换行、失败草稿、复制迟到、单模态、文件同意、ZBar对实际画布预览与下载PNG独立解码、已加载页HTTP离线转换、800字节边界/编辑清码及异步旧结果拒绝。
- 每引擎7张真实界面，共21张；桌面深浅/390px手机宽度/已核码设备，另检查320px窗内溢出。Linux WebKit默认UA可能在界面显示Mac/Safari，不是macOS或iOS实机。没有通过mock连接状态制作成功截图。
- 完整既有套件也通过：三引擎Worker/清单、严格六组合双向SHA、恢复/OPFS/整浏览器进程退出、HTTPS/WSS/Nginx、PWA缓存/失败安装/等待/升级回滚及UI。Chromium 1GiB实际88966ms，Firefox100MiB7566ms，仅此Runner受控用例，非公网测速或SLA。

本地系统Chromium实试因process_singleton socket EPERM在启动中止；它未计为浏览器通过。原生成功来自实际GitHub Runner。

| 本轮真实文字与文件流程 | Chromium | Firefox | Linux WebKit |
|---|---:|---:|---:|
| 文件字节/独立完整SHA | 126976/一致 | 126976/一致 | 126976/一致 |
| 服务端收到的WSS帧/字节 | 14/3640 | 22/5140 | 17/3683 |
| 二进制WSS/正文标记 | 0/未见 | 0/未见 | 0/未见 |
| HTTP请求体字节/上传尝试/外域请求 | 0/0/0 | 0/0/0 | 0/0/0 |

文件完整SHA为`5741d8db80eb69cf38661bcb8435afc5249d6ecad497cd211f4f9494568c1e5f`。统计只覆盖测试观测路线，不是服务器出入总带宽。另包含1GiB用例的Chromium建立连接后观察窗记录43条/1477B、Firefox8条/1297B信令，未见正文；初始页面/SDP不包含在这个较晚窗口内。

## 精确运行候选与截图捕获

459普通文件（430源码/29dist）已独立无Git解压、root/server锁文件重装、427项、无Git重建、29项构建逐字节/模式核对，双次tar/manifest一致。实际CI artifact13601501855的ZIP1064753B，SHA`15530918484cdd1cead8958031bc3c7db1a2284aabd5d6384657210028506b77`；tar1044902B，SHA`893a4415569bed6d2a1d3f151d401896a44625d1412994a00665465fa055c800`，与独立候选完全同一。安全成员/白名单/模式/大小/SHA及Git树和父提交已核对。

manifest提交`7c969df64ce4d9e904a86d0bd14e6d84690c7439`是未改main2b4f75c与运行033d88b的临时PR合并，树与运行码完全相同，不是main被合并。原始报告`evidence/text-qr-runtime-extraction.json`、`text-qr-ci70-candidate.json`。后续文档候选有自己的文件数/manifest/SHA，不能用这个旧包哈希校验另一个包。

CI70原图使用fullPage捕获，固定弹窗外会拼接当前viewport以外背景；后续只在测试层将QR弹窗改为viewport、配对图等待提示自然消失，并记录screenshotModes。没有裁剪/生成/重绘UI，也没有改应用字节或放松断言。最终截图候选/最新CI结果在PR中对应精确提交；此处CI70认证的是同一b46de331c87a6628运行码。

## 正文路线复核

实际源码：server/index.js拒绝binary，只转发同房有界SDP/ICE；deployment/nginx.conf静态仅GET/HEAD、1KiB body上限，唯一WSS代理没有上传服务。network.js只配STUN，getStats选中已知非relay后且双方人工核码才允许传输。transfer.js的文件块/元信息/哈希/恢复/文字经sendJSON或_send抵达RTCDataChannel.send，无HTTP/WSS回退。vendor.js本地打包二维码生成器，无外部QR请求。

既有CI68原始证据在同机/STUN关闭场景记录Chromium68条/1851B和Firefox11条/1342B信令，未观察文件正文；此为既有运行范围，不能代替新改动或真实公网证据。

产品实现不上传、存储或代理正文，并不意味着服务器总流量为零：网页、信令、心跳及STUN会产生少量流量。信令白名单不是语义DLP，攻击者还可以发送被拒绝HTTP请求体或在受限SDP中隐蔽编码，因此不宣传服务器物理上绝不可能收到任意正文字节。生产主机与真实WAN的抓包/计数和文件独立SHA仍须Issue #4实测。

## 未完成的验收

整体仍为未发布开发候选，界面进入实际代码但不等于全部产品/设计验收。真实跨运营商/CGNAT/IPv6/严格防火墙/切网、Android/iOS/macOS Safari/真实文件保存与资源限制、用户独立主机TLS/证书/systemd/升级回滚、12小时/多日与生产容量仍待实测；Issue #4/#5保持开放、PR保持Draft、main/正式环境未改。真实手机镜头扫描仍待实测，独立解码不代表所有镜头/屏幕/光照可用。
