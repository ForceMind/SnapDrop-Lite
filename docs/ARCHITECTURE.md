# Zeydrop 协议与安全边界

## 网络通路

- HTTPS：只分发静态资源；Nginx 拒绝上传方法，1 KiB request body 上限。
- WSS `/server/webrtc`：`hello`、`create-room`、`join-room`、`leave-room`、`signal`、`ping/pong`。只转发经过白名单验证的 SDP / ICE；ICE 中的标准可空字段（sdpMid、sdpMLineIndex、usernameFragment）允许为空/缺省以兼容浏览器实现，但禁止额外数据字段和 relay 候选。不转发文本、文件元信息、哈希或分块。
- WebRTC：可靠、有序 `zeydrop-v2` DataChannel，承载所有用户文件 / 文本。无 TURN 配置，过滤 relay 候选；选中 relay 路径立即停止。
- STUN：可配置、最多四个 STUN server 条目；只接受 `stun:` 地址。默认 Cloudflare / Google 地址已核对官方文档来源，但可用性没有在此环境中验证。不能将它们写成保证可用或自有服务。详见 STUN_CONFIGURATION。

## 邀请和会话

客户端安全随机生成 16 字节邀请 ID；只有 `create-room` 可创建，`join-room` 不会使过期或不存在的邀请复活。未配对邀请固定有效期 15 分钟，最多两名会话成员。第二名加入后立即锁定双方，邀请不能再接纳第三人或替换离开的设备；已配对会话改用独立的固定最长 12 小时期限，恢复不延长时限，避免低速大文件被邀请的 15 分钟期限中断。未配对邀请过期或会话到期时停止连接。原成员只可在两分钟离线预留内恢复；双方离开或预留全部释放后回收已锁定房间。

设备 ID / 32 字节恢复令牌由服务器 `node:crypto` 生成；不接受客户端自报 ID 或 cookie 身份。恢复令牌只在 WS 第一条 hello 消息内发送，保存在当前页内存中，不进 URL / 日志 / localStorage。服务端重启会丢失内存房间及令牌；此时需重新邀请。

对端断线立即撤销旧 peer 的直连及人工确认状态。仅在双方页面未关闭、原锁定成员/本地身份/房间均相同的条件下，可在内存中临时保留已接受文件的 File 与尚未关闭的接收 sink（最多 120 秒）；服务器只保留离线席位，不持有断点或正文。原身份/会话变化、用户取消、超时及校验不一致时必须取消，不能替换接收设备。重新协商后必须再次核对安全码。

## 身份与直连证据

先完成 ICE / DTLS 协商，提取双方 SDP 中 SHA-256 certificate fingerprints，规范为大写、排序连接，再 SHA-256，显示前 48-bit（12 个十六进制位）供人工比较。两端分别允许后方可发送。它降低未比较身份时误传的风险，不是账户体系，也不替代安全的带外比较。

路径先读 `transport.selectedCandidatePairId`，兼容报告显式 selected pair 的实现。只使用已选中 pair；不能用单独 nominated 推断。读取双方 candidateType、协议、地址族和 currentRoundTripTime。不向服务器上传候选路径统计，IP 信息只参与必要 ICE 信令。浏览器隐藏地址或候选字段时标记待核验，禁止虚构直连成功。

失败 / disconnected 后有界 ICE restart（单 offerer，最多两次）；没有无限重试或文件代理。双方 tab ID 使用服务器签发的随机身份进行 offerer 排序。

## 文件协议 v2

1. 通道 hello `{version:2}`；旧协议拒绝。
2. `offer {id,name,size,mime}` → 接收方人工同意、打开 sink → `accept {id}`。
3. 发 ≤16 KiB 二进制分块，每 ≤256 KiB 发送 `checkpoint {id,offset}`。
4. 接收端串行完成写入后 `ack {id,offset}`；发送端只在精确偏移确认后继续。
5. 双方独立增量计算 SHA-256；`finish {id,sha256}` 只能在声明长度完全一致时核验。
6. 接收端 hash 匹配、sink.close 成功后 `complete {id,sha256}`，发送方也必须核对值。零字节文件同样执行哈希和完成协议。

`pause/resume/cancel` 绑定 transfer ID。当前连接内暂停保留 offset。同页短时断线时，双方可以保留已接受、未完成的当前文件和待发送 File 队列，最多 120 秒；未接受的旧 offer 必须用新 transfer ID 重新向接收方取得明确同意。在未完成新的非 relay 路径和安全码核对前不发送队列。跨页面刷新支持用户主动启用的单个接收文件 OPFS 检查点，及另外主动保存的发送清单。发送清单只保存本机元数据/完整SHA-256，必须重选全部原件并重新授权，不能自动恢复File句柄。若上一件 Blob 仍待手动保存，不跨连接复用 ready-next，剩余队列需用户重新选择。

### 同页断点恢复扩展（仍使用 RTCDataChannel 协议 v2）

1. 原设备短时恢复、重新选中非 relay ICE 路径、双方重新人工验证安全码后，发送端发 `resume-offer {id,name,size,mime}`；与本地已经接受的元数据不完全匹配时接收端拒绝。
2. 接收端串行完成已在途写入，基于**已写入字节数**和当前 SHA-256 状态的副本发送 `resume-at {id,offset,sha256}`。已经发送但未实际写入的旧数据不得计入偏移。
3. 发送端分块重新读取**本地原 File 对象**的 `[0,offset)`，计算独立 SHA-256 并与接收端摘要精确比较。不同则发送取消并尝试 abort 未完成 sink；相同则发 `resume-confirm {id,offset,sha256}`。
4. 接收端验证 offset/前缀摘要完全一致后才放行新二进制块；DataChannel 有序传送保证确认先于后续数据。完成后仍必须比较整个文件 SHA-256 并成功关闭 sink 才算完成。

仅延续同一页面中的短时已授权传输（120 秒截止、不延长锁定房间 12 小时上限）。接收方主动选择的实验性 OPFS 持久化恢复已实现；跨刷新必须新邀请、重新核对身份、发送方重选原文件与独立前缀校验，不恢复旧信令身份。发送清单仅重建用户明确重选/完整哈希匹配后的待发顺序。WebSocket 只重新鉴权原身份并交换 SDP/ICE，恢复消息、文件名、offset、哈希与文件正文全部**留在 RTCDataChannel**。网络重试最多两次，不引入服务器文件中转。恢复前缀哈希会额外读取本地文件，但以 256 KiB 分段计算，不要求将整个文件载入内存。

发送 DC buffer 上限 1 MiB，接收异步处理队列上限 1 MiB，持久化确认窗口 256 KiB；同时最多一个发送、一个接收。回退内存池对接收中和已完成待保存 Blob 合计限 64 MiB，关闭保存弹窗释放；接收方保存 / 丢弃后发送 `ready-next`，发送队列才提交下一个文件邀请，避免两个确认弹窗重叠。

## 防护与尚存限制

- 精确 WS Origin 和无 query 的 `/server/webrtc` 请求路径，不解析未鉴权 URI；生产环境未配置 ALLOWED_ORIGINS 则拒绝启动。
- 64 KiB frame / message，240 条 / 分钟、512 KiB / 分钟，每连接计数包含心跳；128 KiB WS 输出缓存阈值；1000 个全局房间 / 会话 / 连接上限。
- 无压缩、拒绝二进制 WS，信令目标必须是同一未过期房间的实际成员；嵌套对象字段白名单。
- 文件名去除路径分隔符与控制字符；DOM 使用 textContent；不自动打开收到的 HTML / URL / 图片。
- Nginx TLS、CSP、no-referrer、访问日志省略 query；服务账号无特权、文件系统只读。
- 服务器不能识别所有恶意信令中的隐蔽数据编码。协议不提供文件转发接口，受限 SDP/ICE 仍是小流量协商通道；不承诺抵抗无限 botnet / 所有 DoS。
- 目前需人工处理邀请误分享、浏览器存储配额、接收磁盘满、后台冻结、设备权限拒绝；未取得跨运营商 NAT 矩阵证据。

## 本机连接诊断

诊断工具仅在当前页保留最多 120 条白名单状态记录，并用页内匿名序号代替设备 ID（最多 30 个映射）。用户主动点击后通过 Blob 下载 JSON；没有上传接口和远程分析。构建版本/revision 随报告保存；字段只包含信令/ICE 状态、候选类型和计数、选中路径的协议/地址族/RTT、STUN 错误标记及浏览器能力。禁止序列化完整事件、RTCStatsReport、SDP、任意错误原文、IP、邀请/会话令牌、安全码和文件信息。

## 2026-11-06 异步与持久化一致性

恢复会复用 File/状态对象，因此每次中断增加发送代次；异步读取、前缀计算及背压错误必须属于当前代次，不能仅靠对象相同判断。旧接收wire的异步错误不得关闭当前通道。空MIME统一为application/octet-stream，存储检查点失败按文件取消处理。

远端ICE候选的ufrag若与当前remote SDP不符，不能立即addIceCandidate，也不能把先于SDP到达的新代候选直接丢弃：最多64项/10秒缓存，匹配后再应用。浏览器提供的空candidate对象保留mid/index/ufrag按标准转发，null legacy gathering事件不合成全局结束标记。候选传递或addIceCandidate resolve均不证明选中路径。

OPFS Worker请求按顺序执行；恢复在取得独占句柄后重读元数据，完整记录提交后才释放数据锁；桥接只接受当前Worker回调。断点过期/损坏而因锁或近期写入未能清理的记录仍可查看删除，不能选择恢复。细节与局部验证见ENGINEERING_AUDIT_20261106。


## 公共静态资源发布边界（2026-11-06）

构建只从显式公共资源清单读取当前25项客户端输入，核对文件及父目录均非符号链接、文件为普通文件后，对同一份内存快照计算revision并写入dist；vendor、全文件和增量哈希Worker也从已核验源码快照打包。未批准的本地.env、笔记或其它client额外文件不进入dist，也不参与revision。不依赖.git，解压源码候选也适用；添加公开资源时必须同步该清单。dist仍是重新生成的公共目录，不放入本地配置。

Nginx另外拒绝隐藏路径（含嵌套及编码后的.env/.git），保留标准.well-known路径。临时HTTPS测试故意在独立静态目录放入可读合成私密文件，验证实际404及正常ACME示例路径200；它不证明真实证书签发或续期。此边界源于旧9ad隔离构建会把两个未追踪client文件复制到dist的可复现实验，并非已观察到真实用户秘密泄漏。

## 发送任务恢复及容量原子性（2026-11-06）

失败的发送任务保留本页File引用（最多30项/15分钟），暂停后续队列；手动重试生成全新transfer ID，接收方须再次同意。继续/清空不绕过Blob的ready-next屏障；清空也释放held队列。断线清除失败重试引用，短时恢复队列仍遵循原身份/120秒/新安全码门槛。

发送清单以Web Locks锁内revision CAS提交，256KiB增量全文件哈希在锁外计算，提交/重新绑定前再检查revision；最多100项/128KiB、固定24小时，条目成功后移除不延期。另一标签页更新会撤销本页原件绑定。完成消息经完整SHA-256验证后，且哈希匹配该清单，才移除当前条目；拒绝/取消/100%进度不能触发移除。

WS握手仅保留独立1000连接上限，新会话容量必须在hello实际分配之前同步检查。否则多个已升级未hello的socket会越过1000会话；同时，满会话表仍允许原离线身份在有界连接内提交恢复令牌。不得因为满表而阻止合法恢复，也不得扩大连接总数。

## 应用握手的有界确认（2026-11-06）

selected UDP/DTLS/DataChannel已连接，不保证首条应用hello已被处理。每个新通道以独立安全随机nonce发送v2 hello，每秒最多10次；收到当前wire/path epoch队列实际处理的hello才回复匹配nonce的hello-ack（最多10次，不应答ACK，防echo循环）。新对端须双方hello及本端nonce被ACK才协议就绪，仍不能替代非relay路径、DTLS人工核码与逐文件接收同意；ACK本身不设置对端hello或人工验证。

绑定已open通道立即启动；断线、替换、失败和关闭清计时器，旧wire/旧epoch/旧nonce不得确认新通道。重复hello不重复恢复任务。有nonce的新对端耗尽后明确协议失败，不能误归NAT；旧v2无nonce保持兼容、有界停止重试。文件、文字及恢复共用当前传输就绪门槛。CI50原失败及旧HEAD单向丢首条hello的失败夹具保留，10项握手/1项阶段分类回归验证，不代表真实网络/NAT恢复通过。

本机发送清单的Web Locks回调只返回成功/失败结果，不把配额或损坏异常抛出原生callback；锁释放后向调用方重抛同一错误对象。这样保留错误、原子提交和并发检查，同时避免把已处理的失败暴露为浏览器全局异常。Firefox最终errors[]断言继续保留，以后续实际CI验证。


## 发送清单全量哈希 Worker（2026-11-07，CI57已验证）

保存清单和重新选择原件时，原生 File 交给本机专用 `file-hash-worker.js`；桥接先转换成不含文件名/修改时间的 Blob 视图再 structured clone，Worker 用锁定的本地 Noble SHA-256 逐个读取 256 KiB 切片。不会先创建完整 ArrayBuffer，不访问网络。构建从批准源码快照打包 Worker，继承 shell revision 查询参数并纳入同版本 PWA 预缓存。

同一桥接最多一个活动任务和四个等待任务，含排队的总超时为五分钟。进度最多每秒十次，开始/结束强制反馈；取消、pagehide、崩溃和超时释放引用/终止旧 Worker。消息绑定当前 Worker 和递增任务号，格式、字节数、进度与最终 SHA-256 严格核验。仅浏览器没有 Worker 能力时使用 256 KiB 主线程回退；Worker 创建或运行失败明确失败，不偷偷重算。清单原有 opt-in、锁外计算/锁内 CAS、重选全部原件、跨标签失效及手动重新授权均保留。

上述CI57结果只覆盖当时发送清单的全量哈希Worker，不能用它为后续实时/前缀Worker背书。当前实现已扩展到下面的状态式哈希路径，并由3e7fd6c/CI60独立完整验证；OPFS写入Worker与SHA Worker职责不同，桌面响应时间也不代表移动真机表现。


## 前缀准备与消息队列（2026-11-07，CI57已验证）

发送方处理resume-at时启动独立的前缀准备任务，保留原始wire有效性回调、路径与sendEpoch、state身份。256KiB本机读取不再占住入站串行消息队列，当前wire的cancel仍按原队列顺序处理；旧wire不能越过有效性检查。准备期间phase/resumeBusy阻止accept/resume/ACK触发发送，重复确认被拒绝。前缀完整SHA匹配前不提交offset/hash或发送resume-confirm。

每次取消/断线/超时使任务取消等待；原生Blob I/O本身没有Abort API，迟到结果必须消费且不能更新新状态。全页最多四个尚未结束的前缀读取，每次不超过256KiB；仅底层读取真正完成才释放名额，超限只取消该文件的恢复并提示稍后重试或完整重发。读取结果须为真实ArrayBuffer且长度精确，防止短读搭配伪造摘要跳过内容。恢复后pump错误仍绑定原wire/epoch，不能取消新代任务。

接收侧快照也采用相同的256KiB/4挂读任务；只park精确原sink一次，完整校验后原子交接。restore/park RPC本身挂起及物理锁释放仍另有边界，不把逻辑取消等同于终止磁盘I/O。

恢复Worker在recovery.js模块求值时捕获脚本URL和revision，延后创建也使用相邻路径和同一查询参数，命中同版本PWA缓存；不接受跨源/带凭据脚本地址。服务器query参数本身不是不可变文件版本，Service Worker更新策略及真机离线体验仍分别验证。


数据保留最终修复在CI57通过：durable存储失败按原state/resumeOwner定位；活动取消、过期交接均等当前消息链、旧adopt ready及已开始write正确记账后park。真实最终SHA匹配后缓存用于finish失败清理，transient迟到locallyStored结果不自动删除/报远端完成。Worker park提交失败仍尝试关闭句柄并释放active，保留旧metadata与主错误；RPC最多32项且序号安全。主动取消/删除、确证损坏和普通sink保持对应策略。详见ENGINEERING_AUDIT_20261107与RECOVERY_STORAGE。


## 状态式传输哈希与安全释放（2026-11-07，CI60已验证）

`stream-hash.js`管理实时发送/接收及双方恢复前缀的独立本机Worker。每页最多4个状态句柄，每状态最多4个活动或排队操作；单次update只复制不超过256KiB，待处理应用数据每状态最多1MiB。调用方原始ArrayBuffer保持可用，不能因Worker转移而破坏随后DataChannel发送。Worker按顺序校验session、请求号和精确offset；状态留在Worker内，`digestHex()`只返回克隆摘要并允许继续，`final:true`消费并释放该状态，不导出Noble内部状态。

Worker延迟到首个操作才创建，每操作默认30秒截止；失败、取消、最终摘要和pagehide释放自身句柄/引用。只有没有Worker能力时才走相同异步FIFO的有界主线程回退；Worker创建/运行/协议异常不会静默重算。构建从批准快照打包本地Noble，脚本与Worker继承同一revision并进入PWA预缓存，不访问网络服务。清单与已完成本机文件复验使用另一全文件Worker桥接，完成复验还要求blob、记录与结果字节数相等。

文件协议本身不改：新异步计算后仍须检查当前wire、路径代次、发送代次及精确state，旧操作不能发ACK、resume-confirm、finish或complete。已开始的接收write即使断线也要完成其对应哈希/offset结算，再通过消息链/交接屏障park；最终消费摘要前标记finishing，不能把已消费状态交给新连接。临时前缀Worker校验通过前不替换活动状态，取消后释放自己的临时Worker；发送侧本机前缀读取/Worker故障只取消该发送文件，不把另一方向接收文件作为协议损坏而删除。

若write已经成功、update或摘要Worker却失败，不能将旧摘要发布到新的磁盘偏移。`parkCommitted()`调用恢复Worker的`releaseCommitted`，只关闭精确记录的活动句柄并返回原已提交offset，不flush/改写metadata、不truncate/erase、不终止共享恢复Worker；显式恢复仍按旧metadata核验并截断未提交尾部。native close失败原样拒绝，逻辑active清理不等于物理锁立即释放；offset为0的原恢复限制不变。

自然会话到期时服务端先发peers=[]再发room-expired，永久连接移除因此统一走保留自愿durable检查点的清理路径。旧身份和held授权随会话结束，不自动绑定历史文件。明确文件取消、手动删除及确证完整性失配仍走相应删除策略；普通非持久sink照常abort。


### 清理失败与本机暂存面板生命周期（CI60已验证）

统一的sink清理助手消费同步abort异常和返回Promise的拒绝，覆盖活动取消、held释放及准备阶段。原生writer.abort失败不再被静默吞掉；用户看到固定的本机清理/删除失败提示，应检查暂存管理或保存位置。提示不序列化任意原生错误文本，不重新归属旧state、不改变新传输；错误已处理不等于底层删除或物理解锁成功。持久检查点保留路径仍按park/parkCommitted规则处理。

完成暂存管理面板为每次显示/刷新维护独立代次，为每条校验使用自己的AbortController；隐藏、刷新、删除和pagehide使旧代次失效并取消相应校验；隐藏/刷新撤销未点击Blob URL，已点击URL保留最多60秒以便浏览器启动下载，删除/pagehide撤销全部并清理计时器。URL注册表最多20项，满时提示等待重试，不通过提前撤销正在启动的下载腾位。异步completed/hash返回后再检查代次，不能向已移除的行或新面板发布保存链接；只取消自身任务，不调用全局cancelAll影响发送清单。校验失败保留记录，撤销URL也不删除OPFS数据。未点击URL不依赖用户最终点击才释放，已点击的有界延迟撤销保留。

CI60的原生OPFS故障组合验证写入后Worker异常、原metadata保留、重载前文件锁释放和新授权恢复的完整SHA；原始JSON见evidence/ci60-stream-hash-recovery-chromium.json。此为同机可控Worker故障，不等于硬件磁盘故障或Safari/移动测试。
