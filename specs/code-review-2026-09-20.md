# MoeMail 全仓代码复审

审查日期：2026-09-20。基线：`1c13cc3dc26fa80d3084fa757db229c93a6ce49d`。

本文保留修复前的审查结论及当时验证状态；后续 master 修复、升级步骤和新验证结果见 [修复记录](review-fixes-2026-09-20.md)。下文行号对应审查基线。

本次是全仓范围的静态审查，重点逐条检查 API、鉴权与权限、数据库关系、Worker、分享与媒体访问、邮件前端、core/CLI/MCP、部署脚本和 CI；不是线上渗透测试，也不是所有界面的浏览器验收。未修改业务代码，未编写单元测试。原有 `code-review-report.html` 保留。

## 结论与修复顺序

第一批处理权限撤销、发信额度、媒体安全和 R2 生命周期；同时修复已经影响正常使用的媒体时间精度、CID 和 Turnstile 注册流程。密码方案应尽快迁移，但不能直接换算法导致老用户无法登录。

以下 P1 表示优先修复，P2 表示随后安排。标为“静态确认”的结论有代码路径依据，但没有在 Cloudflare 线上复现；“局部复现”只涵盖明确列出的本地场景。条件性安全影响均单独说明。

| 顺序 | 编号 | 问题 | 验证状态 |
| --- | --- | --- | --- |
| 1 | R01 | API Key 绕过角色权限，降级后仍可管理邮箱 | 静态确认 |
| 2 | R02 | 用户删除发件记录即可恢复每日额度；并发也未原子扣减 | 删除路径局部复现；并发静态确认 |
| 3 | R03 | SVG 附件可作为同源活动文档返回 | 后端响应局部复现；浏览器执行未复现 |
| 4 | R04 | 生产 PWA 默认缓存敏感 API 和页面 | 项目配置及锁定版本上游源码确认；浏览器待验收 |
| 5 | R05 | 邮箱删除、用户删除、定时清理遗漏 R2 对象 | 定时清理局部复现；其余静态确认 |
| 6 | R06 | 媒体 Worker 秒/毫秒比较使有效图片返回 410 | 实际 Worker 函数局部复现 |
| 7 | R07 | CID 正则转义错误导致图片替换失败甚至中断收件处理 | 原代码表达式局部复现 |
| 8 | R08 | 开启 Turnstile 后注册自动登录复用已消费 token | 调用链与官方协议确认 |
| 9 | R09 | 完整邮件正文和附件进入生产日志 | 静态确认 |
| 10 | R10 | 管理员初始化无唯一性保障 | 数据库约束局部复现；并发静态确认 |
| 11 | R11 | 快速密码哈希与认证密钥耦合 | 静态确认，迁移需单独设计 |

## 第一批问题

### R01 — P1：API Key 请求跳过角色权限检查

位置：[middleware.ts:32](/Users/geneyuriy/Workspace/Opensource/moemail/middleware.ts:32)、[apiKey.ts:27](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/apiKey.ts:27)。

中间件遇到 API Key 后直接返回 `handleApiKeyAuth`，跳过后面的 `API_PERMISSIONS` 检查。该函数仅验证 key 存在、启用、未过期，以及路径前缀；没有检查用户当前角色。邮箱列表/详情/删除只检查所有权，创建接口也没有拒绝 civilian。

触发：公爵创建 key 后被降为平民，原 key 仍可读取、创建、删除自己的邮箱，尽管该角色已没有 `MANAGE_EMAIL`。这不是访问其他用户邮箱的证据，也不是普通 key 可修改管理员配置的证据：配置写接口自身另有权限检查。

修复：将认证与授权统一为 session/API Key 都经过的路径，明确 key 使用资格是否随降级撤销。验收：同一用户降级前后分别用 session 和原 key 操作，权限结果一致；禁用/过期 key 继续拒绝。

### R02 — P1：发信额度依赖用户可删除的消息表

位置：[send-permissions.ts:47](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/send-permissions.ts:47)、[消息删除:50](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/[messageId]/route.ts:50)、[发信接口:110](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/send/route.ts:110)。

每日计数直接查询当前消息表。发完邮件删除该消息，或删除所属邮箱，计数就下降；用户可以重复发送、删除来绕过日限额。额度检查与实际发送也分离，多个并发请求可同时通过。

局部复现：在真实迁移建立的内存 SQLite 中，当前用户当日 sent 记录数在删除后从 1 变为 0。无需并发即可触发，因此比原报告纠结 `receivedAt` 字段更重要。

修复：独立、不可由用户删信操作抹掉的用量账本，发送前原子预留额度；定义供应商失败、超时状态和幂等重试。不要用数据库事务包住网络发送来假设端到端原子性。验收：删除发件记录不返还已消费额度；剩余一次额度时并发请求只允许一次。

### R03 — P1：允许未净化 SVG 以同源活动文档呈现

位置：[收件过滤:42](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:42)、[媒体 Worker:39](/Users/geneyuriy/Workspace/Opensource/moemail/workers/media.ts:39)、[Pages 媒体接口:49](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/media/[messageId]/[attachmentId]/route.ts:49)。

收件端接受所有带 CID 的 `image/*`，包括 `image/svg+xml`，原始字节进入 R2。两个媒体出口按原 MIME 返回，使用 `Content-Disposition: inline`，没有文档 sandbox CSP。部署脚本会把媒体 Worker 路由挂到站点 `/api/media/*`，因此存在同源部署场景。

条件：有效媒体 URL 被作为顶层文档打开，且媒体与应用同源。此时 SVG 的风险不同于 `<img>` 中的 SVG；不能依靠邮件预览 iframe 的 sandbox 保护直接打开的媒体文档。MDN 明确区分这两种上下文：[SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)。

局部复现确认 Worker 返回 SVG、inline、无 CSP 的 200 响应；未执行浏览器脚本或线上攻击。因此此处是代码路径明确的条件性风险，不声称仅打开邮件预览就能执行脚本。

修复：先限制为经过类型验证的位图格式，或安全转码；如必须保留 SVG，使用隔离的媒体源并施加文档级限制，同时处理已有 SVG 对象。验收：直接打开历史和新 SVG URL 不获得应用源上的脚本执行能力。

### R04 — P1：PWA 缓存策略不适合私人邮箱与管理员配置

位置：[next.config.ts:30](/Users/geneyuriy/Workspace/Opensource/moemail/next.config.ts:30)、[锁定依赖:76](/Users/geneyuriy/Workspace/Opensource/moemail/pnpm-lock.yaml:76)。

生产启用 next-pwa 5.6.0，但没有定制 runtimeCaching。该版本默认缓存除 `/api/auth/` 外的同源 GET API，使用 `apis` 缓存和 10 秒网络回退；还缓存其他同源页面。上游源码：[next-pwa 5.6.0 cache.js](https://github.com/shadowwalker/next-pwa/blob/5.6.0/cache.js)。

这使邮件正文、分享结果以及管理员读取到的含密钥配置可能留在同一浏览器的 Cache Storage。项目没有退出时清除这些缓存或按用户隔离。断网/网络超时回退时，注销和切换账号不等于清除了旧数据。不能把在线情况下正常返回 401/403 的每次请求都描述为会回退缓存。

修复：私人 API、认证相关页面和分享内容使用 NetworkOnly；清理旧版本遗留的 `apis`/敏感页面缓存。仅增加 HTTP `no-store` 不能替代 Service Worker 规则变更。验收需用生产构建：先登录 A 查看邮件和配置，再退出/登录 B，断网并模拟慢网络，确认没有 A 的数据回退。

### R05 — P1：三条删除路径会遗留 R2 对象

位置：[邮箱删除:35](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/route.ts:35)、[用户删除:45](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/users/[id]/route.ts:45)、[cleanup.ts:24](/Users/geneyuriy/Workspace/Opensource/moemail/workers/cleanup.ts:24)。

1. 邮箱删除使用邮箱 ID 查询附件的 messageId，拿不到所属消息的对象键。
2. 用户删除只删除 API Key 和用户，再依赖数据库级联；没有删除 R2 对象。
3. 定时任务先挑选 100 个附件删除 R2，随后以 100 条消息为单位删除附件记录，再以 100 个邮箱为单位删邮箱；三次操作的集合不一致。

局部复现：一封过期邮件含 101 个附件时，原查询只选中 100 个 R2 key，下一条 SQL 删除全部 101 条附件记录，剩下 1 个无法由后续数据库扫描发现的对象。级联删除不能删除外部 R2 数据。

修复：固定同一批邮箱/消息 ID，收集其全部对象键，分批删 R2，确认后再删记录；失败时保留可重试的清理信息。统一用户、邮箱、消息、定时删除流程；现有孤儿对象另做离线对账。验收覆盖多附件、大批量和 R2 部分失败。

### R06 — P1：媒体时间精度不一致，正常 URL 返回 410

位置：[生成签名:64](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:64)、[保存过期时间:81](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:81)、[Worker 查询:25](/Users/geneyuriy/Workspace/Opensource/moemail/workers/media.ts:25)。

URL 的 exp 是毫秒时间向下取整为秒；附件 expires_at 保存原始毫秒值。Worker 又要求 `ma.expires_at = exp * 1000`。有限期邮箱创建时保留毫秒，所以只要毫秒部分非零，即使 token 正确也查不到附件。永久邮箱的整秒时间通常不触发，Pages 媒体接口也没有这一相等条件。

局部复现：直接调用当前 `workers/media.ts`，D1 由内存 SQLite 适配、R2 为假数据；过期时间带 `.123` 毫秒时返回 410，改为对应整秒值返回 200。

修复：统一精度/比较语义并兼容已经生成的 URL 和数据库记录，不能只改新记录。验收覆盖旧有限期邮箱、新有限期邮箱和永久邮箱。

### R07 — P1：CID 的正则转义损坏，附件处理可中途失败

位置：[email-receiver.ts:85](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:85)、[media.ts:28](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/media.ts:28)。

CID 替换表达式没有正确转义正则元字符。直接执行原表达式，`a+b@example` 没有被替换；`a(b@example` 抛出 `Invalid regular expression`。这里位于 R2 上传和附件插入之后，异常会跳到外层 catch，剩余附件与 webhook 不再处理。另有 `decodeURIComponent` 对不合法百分号编码直接抛异常的问题。

修复：正确转义、用 HTML 属性解析进行精确 CID 匹配，避免前缀误替换；规范化 CID 不应因普通非 URI 字符中断整个收件流程。验收覆盖 `+`、括号、点号、百分号和互为前缀的 CID。

### R08 — P1：Turnstile token 在注册和自动登录中重复消费

位置：[注册校验:23](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/auth/register/route.ts:23)、[自动登录:169](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/auth/login-form.tsx:169)、[登录校验:135](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/auth.ts:135)。

注册已将 token 交给 Siteverify 校验；成功后前端用同一个 token 调用 credentials 登录，服务器再次校验。Turnstile token 只能验证一次，重复使用会失败：[Cloudflare 服务端验证说明](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。

影响：开启 Turnstile 的正常新用户已经注册成功，却看到自动登录失败。修复可选择注册成功后要求重新验证再登录，或设计安全的一次注册并建立会话流程；不能为了自动登录跳过普通登录验证。验收使用开启 Turnstile 的真实注册流程。

### R09 — P1：完整邮件内容被写入生产日志

位置：[email-receiver.ts:15](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:15)。

`parsedMessage` 包含邮件正文和附件信息；验证码、重置链接和其他私人内容进入 Worker 日志。邮箱删除不会同步删除日志副本。

修复：只记录处理 ID、状态、耗时和必要的非敏感计数；同时移除完整主题日志或按明确规则脱敏。验收发送含唯一标记的合成邮件，确认生产日志不包含正文/附件内容。已有日志的保留和访问范围应单独核查。

### R10 — P1：皇帝初始化没有数据库唯一性与原子领取保障

位置：[init-emperor:17](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/roles/init-emperor/route.ts:17)、[schema.ts:95](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/schema.ts:95)。

端点先读后写；`role.name` 没有唯一约束，`user_role` 的复合主键也不限制同一角色只能有一个用户。首次两个用户同时领取时，既可创建重复 emperor 角色，也可能占用同一个角色。

局部数据库检查允许插入两条同名 emperor 角色。并发调用未在线复现。README 明确要求站点只有一个皇帝，因此这是业务约束缺失，而非个人风格建议。

修复：对唯一管理员身份做数据库级原子领取，并对 role.name 增加符合现有数据的唯一约束；普通角色不能简单全部限制为单个用户。变更角色的 delete+insert 也应原子化，防止会话自动补角色与降级操作交错。验收并发领取只有一人成功，失败不清空原角色。

### R11 — P1：密码哈希与 AUTH_SECRET 耦合，应规划兼容迁移

位置：[utils.ts:8](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/utils.ts:8)、[auth.ts:250](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/auth.ts:250)。

当前仅计算一次 SHA-256，缺少每条密码的随机盐与可调工作因子。同一密码在同一密钥下生成同一哈希；轮换 AUTH_SECRET 会使老密码全部无法验证。

这里不认定为无需前提的远程 Critical。离线猜测风险取决于数据库和 pepper/密钥的泄露情况。原报告把普通字符串比较直接描述为远程逐字节破解也没有足够证据。

修复：选择实际 Edge 运行时可支持且资源开销经过测量的密码 KDF，保存算法版本、参数与每用户随机盐，设计旧格式成功登录后升级或密码重置流程，并解耦会话密钥。已有用户迁移前不要直接轮换掉验证旧密码所需的秘密。

## 第二批问题

### R12 — P2：邮箱过期检查在各路径不一致

位置：[单消息分享 API:30](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/shared/message/[token]/route.ts:30)、[分享页面数据:147](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/shared-data.ts:147)、[收件查询:18](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:18)、[发信邮箱查询:83](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/send/route.ts:83)。

整邮箱分享会检查邮箱过期，单消息分享 API/SSR 只检查分享本身。收件和发信也不检查邮箱 expiresAt。邮箱过期到定时清理之间，旧单消息分享仍可访问，旧地址仍能收发邮件；清理停摆会延长窗口。

修复：在每次业务操作和分享读取时统一判断邮箱有效性，清理任务只负责物理回收。验收暂停清理、让邮箱过期，确认分享/收件/发件都按契约拒绝。

### R13 — P2：媒体缓存时间超过访问凭证剩余寿命

位置：[Worker 响应:42](/Users/geneyuriy/Workspace/Opensource/moemail/workers/media.ts:42)、[Pages 响应:52](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/media/[messageId]/[attachmentId]/route.ts:52)。

所有媒体返回固定 `public, max-age=86400, immutable`，即使邮箱/签名一分钟后就过期。已缓存的响应在新鲜期内可以不再回源检查过期和删除。

修复：根据隐私与撤销要求选用 no-store 或明确受限的缓存策略；至少 TTL 不超过剩余有效时间。删除后的即时撤销与长缓存不能同时假设成立。验收需要浏览器/CDN缓存场景；本次仅确认响应头。

### R14 — P2：邮箱地址不区分大小写的唯一性只靠先查后插

位置：[生成邮箱:70](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/generate/route.ts:70)、[schema.ts:53](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/schema.ts:53)。

应用和收件 Worker 按 LOWER(address) 判断同一个地址，但数据库只对原 address 唯一，LOWER 索引不是 UNIQUE。并发创建大小写不同的地址可同时成功，收件时 findFirst 只选其中一个，造成投递归属歧义。局部迁移数据库允许 `a@example.invalid` 和 `A@example.invalid` 同时存在。

修复：统一地址规范化并添加不区分大小写的唯一约束，迁移前处理已有冲突；捕获唯一冲突返回 409。邮箱数量配额同样是先查后插，应按是否允许短暂超额确定原子性要求。

### R15 — P2：Webhook 正常收件路径忽略 HTTP 错误且没有超时/重试

位置：[email-receiver.ts:98](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:98)、[webhook.ts:19](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/webhook.ts:19)。

正常收件直接 fetch，不检查 response.ok；500 响应不抛异常，会被当作已完成。网络异常有日志，因此原报告“所有失败静默吞掉”不准确。测试 webhook 使用另一个有超时/重试的函数，两条路径行为不一致。

修复：共享投递实现，明确成功状态、超时、有限重试；若需要可靠投递，采用持久化队列并提供事件 ID 让下游去重。验收 HTTP 500、超时、连接失败和成功响应。

### R16 — P2：发送成功但数据库写入失败，客户端重试会重复投递

位置：[send/route.ts:110](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/send/route.ts:110)。

Resend 已发送后才插入 message。若这一步失败，返回 500，但邮件已经发出；没有请求幂等键，也未保存供应商返回的发送 ID。建议与 R02 一起设计 pending/sent/failed 状态和请求幂等，验收供应商成功后数据库失败的恢复流程。

### R17 — P2：邮件详情存在旧请求覆盖新选择与显示模式残留

位置：[message-view.tsx:43](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/emails/message-view.tsx:43)、[message-list.tsx:71](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/emails/message-list.tsx:71)、[共享详情请求:156](/Users/geneyuriy/Workspace/Opensource/moemail/app/[locale]/shared/[token]/page-client.tsx:156)。

快速切换邮件/邮箱时，旧请求没有取消或请求序号检查，晚到的响应仍写入当前组件状态。另一个确定的状态路径：查看纯文本邮件会把 viewMode 置为 text，随后打开只有 HTML 的邮件不会重置为 html，而且没有文本/HTML切换控件，正文可能为空。

修复：以资源 ID 校验响应归属或用 AbortController 清理请求；切换消息重置适用的显示模式。验收用网络节流制造 A 请求比 B 晚返回，并覆盖纯文本到 HTML-only 的切换。

### R18 — P2：每日额度耗尽会隐藏已发送邮件列表

位置：[message-list-container.tsx:23](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/emails/message-list-container.tsx:23)、[send-permission API:18](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/send-permission/route.ts:18)。

前端用包含当日余额判断的 canSend 控制是否显示“已发送”标签。用户达到日限额后刷新页面，虽然服务端列表接口使用不检查额度的 checkBasicSendPermission，前端却隐藏全部发件记录。

修复：把“有发件/查看发件箱资格”和“当前还能发送”分开。验收余额为 0 时能查看历史，但不能继续发送。

### R19 — P2：core/CLI/MCP 的等待截止时间不可靠

位置：[poll.ts:43](/Users/geneyuriy/Workspace/Opensource/moemail/packages/core/src/poll.ts:43)、[api.ts:30](/Users/geneyuriy/Workspace/Opensource/moemail/packages/core/src/api.ts:30)、[CLI wait:19](/Users/geneyuriy/Workspace/Opensource/moemail/packages/cli/src/commands/wait.ts:19)。

轮询只在 sleep 前检查超时，sleep 和 fetch 可越过截止时间；HTTP 客户端没有传递取消信号/请求超时。CLI parseInt 也没拒绝 NaN、负数和零 interval。MCP 的输入上限不能保证底层请求在规定时间结束。

局部调用当前 pollForNewMessage，以合成响应代替网络：timeoutMs=10、intervalMs=60，63ms 后返回 received 而不是 timeout。修复应使用绝对 deadline、限制 sleep 长度、在请求后再次检查，并将取消信号传到底层 fetch。CLI 对数值做范围验证。

### R20 — P2：局部部署配置会把媒体指向错误站点/Zone

位置：[mediaBase:37](/Users/geneyuriy/Workspace/Opensource/moemail/workers/email-receiver.ts:37)、[部署 vars:95](/Users/geneyuriy/Workspace/Opensource/moemail/scripts/deploy/index.ts:95)、[zoneName:89](/Users/geneyuriy/Workspace/Opensource/moemail/scripts/deploy/index.ts:89)。

MEDIA_URL_BASE 为空时收件端硬编码 `https://moemail.app`，部署脚本并不会从 CUSTOM_DOMAIN 自动补出它。自建站点遗漏该变量时生成的图片 URL 指向别人的站点。另以域名最后三段推断 Zone：`mail.example.com` 通常属于 `example.com` Zone，当前却推断为 `mail.example.com`，导致未提供 MEDIA_ZONE_NAME 的常见部署失败。

修复：显式验证必需媒体源，或从已确定的部署域名推导；Zone 使用显式配置或 Cloudflare 查询结果，不能按固定段数猜测。验收子域名、二级公共后缀域名、Pages 默认域名。

## 小改动可随首批一起完成

- [注册响应:33](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/auth/register/route.ts:33) 返回完整 user，包含刚生成的 password 哈希。改为公开字段白名单。当前只证明返回注册者自己的哈希，不扩大描述为泄露其他用户密码。
- [消息详情:106](/Users/geneyuriy/Workspace/Opensource/moemail/app/api/emails/[id]/[messageId]/route.ts:106) 的 sent_at 错取 receivedAt，应按 API 契约返回 sentAt。
- [getUserRole:73](/Users/geneyuriy/Workspace/Opensource/moemail/app/lib/auth.ts:73) 对空角色数组直接解引用；生成邮箱在 try 外调用它。角色异常应明确拒绝并返回受控错误，不应默认补成高权限角色。
- 两个 HTML 预览组件的 effect 调用 updateIframeContent 却不 return 其清理函数，切换内容/主题后 ResizeObserver 和 resize listener 累积。位置：[私有详情:181](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/emails/message-view.tsx:181)、[分享详情:152](/Users/geneyuriy/Workspace/Opensource/moemail/app/components/emails/shared-message-detail.tsx:152)。
- [core 配置:55](/Users/geneyuriy/Workspace/Opensource/moemail/packages/core/src/config.ts:55) 保存 API Key 未设置文件 0600、目录 0700，实际可读范围取决于用户 umask/目录权限。应明确限制权限，同时处理已有文件。
- [use-config.ts:55](/Users/geneyuriy/Workspace/Opensource/moemail/app/hooks/use-config.ts:55) 请求失败恢复 loading=false 后会再次触发 effect，持续失败时无限重试。应加入重试上限/退避或显式重试入口。

## 需要额外验证的安全与性能项目

- **依赖安全升级**：锁定 Next 15.1.1、React 19.0.0，必须纳入补丁维护，但不能直接断言当前 Edge 部署存在 React2Shell RCE。Next 官方公告明确 Edge Runtime 不受 CVE-2025-66478 影响，本项目 locale layout 和 API 使用 Edge。Middleware bypass 官方复盘也说明 Cloudflare Workers 不受该部署路径漏洞影响。若改用受影响的自托管部署，结论需要重新评估。参考：[RSC 公告](https://nextjs.org/blog/CVE-2025-66478)、[Middleware 复盘](https://vercel.com/blog/postmortem-on-next-js-middleware-bypass)、[后续补丁公告](https://nextjs.org/blog/security-update-2025-12-11)。尚未做完整依赖树漏洞扫描，不把某个历史修复版本当作今日“全部安全”版本。
- **HTML 净化**：现有正则不足以充当通用 HTML sanitizer，但 iframe 没有 allow-scripts；要依据实际载入点评估。R03 的媒体文档是本次发现的不同边界，不能用 iframe 已 sandbox 来豁免。选库时需验证 Edge 兼容性，不直接套用 jsdom 方案。
- **Webhook SSRF**：URL 到 fetch 的路径存在；localhost/metadata 实际可达性、跳转处理及 Cloudflare 网络限制未复现。可先收紧为明确允许的 HTTPS URL 策略，但不能只做字符串 deny-list 就宣称风险消除。
- **OAuth 账户关联**：需要核查提供商已验证邮箱语义及实际配置。开启 allowDangerousEmailAccountLinking 本身不是已经实现账户接管的证明。
- **登录/注册限流**：代码中没有应用级速率限制；线上是否有 WAF 规则未知。公共 credentials 登录应部署限流并实测；Turnstile 不能替代所有配额保护。
- **分享范围**：邮箱分享列表排除了 sent，但详情接口只验证 mailbox ID、没有过滤 sent。已知某封 sent message ID 的分享持有者能请求它；消息 ID 的可获取路径尚未证明，应确认产品是否将发件排除视为权限边界，并统一服务端过滤。
- **重复查库**：session callback、middleware checkPermission 和路由 getUserId 重复查询有明确路径；尚无请求跟踪和 D1 指标，不能量化延迟。优先消除同请求重复查询；角色缓存必须保持降级/撤权语义。
- **部署 SDK/迁移流程**：部署脚本将 token 传入 apiKey 参数、用数据库名称调用 get、部署时即时 generate migrations 等值得进一步在隔离账号/锁定 SDK 下验证；本次没有调用线上 Cloudflare API，不列为已复现故障。

## 验证记录与限制

- `pnpm lint` 已尝试，因未安装依赖报 `next: command not found`，退出码 1。完整 Next 构建、TypeScript 类型检查和 CLI/MCP 打包未运行；未将这些项目标为通过。
- 使用 Bun.Transpiler 对 app、workers、packages、scripts 及根配置共 144 个 TS/TSX 文件做语法转换，0 个语法错误。这不验证类型、模块解析或部署兼容性。
- 在内存 SQLite 顺序应用仓库 0000–0020 的 21 个 SQL 迁移成功；验证了清理集合不一致、可删除额度、大小写地址重复、重复 emperor role。SQLite 检查不等于 D1 并发/资源限制验收。
- 调用实际媒体 Worker 函数，使用本地 SQLite D1 适配和合成 R2 响应，得到毫秒过期时间 410、整秒 200，并检查 SVG 响应头。
- 直接执行现有 CID 表达式复现匹配失败/正则异常；调用现有轮询函数复现 deadline 越界。均为一次性本地人工检查，没有新增测试文件。
- 五种语言 JSON 的键集合比较一致；未逐句校对翻译质量。
- 没有真实发送邮件、修改线上配置、访问线上用户数据或执行漏洞攻击；没有浏览器 UI、PWA 离线缓存或 Cloudflare 端到端验收。相关验收步骤已在发现中列出。

建议拆成媒体与清理、鉴权与额度、注册与前端、密码迁移四组修复。每组完成 lint/构建及相应人工场景后再部署，避免把密码迁移和大量低收益风格重构混在同一个变更里。
