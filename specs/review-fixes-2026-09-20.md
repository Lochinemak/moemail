# 代码复审修复与升级记录

2026-09-20：将 `feat/inline-image-r2` 快进合并至本地 `master`，合并点为 `1c13cc3`，随后在 master 工作区修复。没有推送、部署或修改生产数据。原始 HTML 报告保留；[复审报告](code-review-2026-09-20.md) 记录的是修复前基线。

## 已落地的修复

| 发现 | 修复 |
| --- | --- |
| R01 | API Key 每次检查当前角色，降级撤销管理邮箱/API Key 资格；限制可访问路径；不信任客户端 X-User-Id。 |
| R02、R16 | 独立 send_request 账本；单条 SQL 原子预留 UTC 当日额度；用户级幂等键、固定供应商幂等键和 pending/sent/failed 状态。删除邮箱/邮件不恢复额度；迟到重试不恢复已删除的邮件。 |
| R03、R13 | 新附件按文件头限制 PNG/JPEG/GIF/WebP；两个媒体出口拒绝 SVG 等类型；返回 no-store、nosniff 和 sandbox CSP。 |
| R04 | PWA 只缓存本站静态构建资源；其余 GET 使用 NetworkOnly；激活新版 Service Worker 时删除旧动态缓存。 |
| R05 | 附件删除触发器把对象键写入持久化队列，涵盖消息、邮箱、用户级联删除；R2 成功后才删队列，失败可重试；定时清理分批处理。 |
| R06、R07 | Worker 按秒比较 URL exp、按实际毫秒检查有效期；HTMLRewriter 精确替换 CID，畸形百分号编码不再抛异常。 |
| R08、R09 | Turnstile 注册成功后重新登录并重新验证，避免复用 token；关闭正文、附件和主题日志。 |
| R10、R14 | 数据库唯一角色名、每用户一个角色、大小写无关邮箱地址约束；数据库触发器保证最多一个 emperor；角色替换使用 upsert。 |
| R11 | 带随机盐和版本参数的 PBKDF2-SHA256；旧 SHA256 密码成功登录时升级，保留旧密钥兼容入口。 |
| R12 | 收件、发件、私有读取及单消息分享 API/SSR 检查父邮箱过期时间。 |
| R15 | 收件和测试 Webhook 共享 HTTP 状态检查、超时、有限重试；禁止跟随重定向。 |
| R17 | 详情请求取消、列表请求序号校验，切换消息重置 HTML/文本模式；预览 effect 正确释放监听器和 observer。 |
| R18 | 将查看发件箱资格与剩余可发送额度分开。 |
| R19 | core 请求超时与取消信号；轮询使用绝对截止时间并覆盖初始请求；CLI 拒绝无效时间参数。 |
| R20 | 新生成配置从明确的媒体域名或 Pages/自定义域名取得源；不再猜测 Zone；缺少媒体配置时跳过内联附件存储。 |

同时修复注册响应暴露自身密码哈希、sent_at 取错字段、空角色解引用、配置请求失败无限重试、CLI 配置文件权限、分享邮箱详情意外暴露 sent 类型。部署脚本改用 token 认证和按名称查数据库，迁移只应用已提交 SQL，不在部署时生成迁移。

## 升级顺序与兼容性

1. 备份 D1，检查下列冲突查询。迁移遇到冲突会失败，**不会自动删除邮箱、用户或擅自决定管理员归属**。冲突数据须由维护者确认归属后处理。
2. 在维护窗口暂停发件和角色/邮箱写入，应用 `0021_review_integrity.sql`，随后一起更新 Pages、收件 Worker、媒体 Worker、清理 Worker。旧代码不能与新账本长期并行，否则旧发送不会记账。
3. 配置已有部署的 `MEDIA_URL_BASE`、媒体路由及 `MEDIA_SIGNING_SECRET`。部署脚本保留已有 Wrangler 文件，不会自动替换其中错误的旧域名。Pages 默认域名通过 Pages 媒体接口访问，不要为 pages.dev 配置自己的 Zone 路由。
4. 更新外部发件客户端以传入 `Idempotency-Key`。本仓网页、CLI、MCP 已更新；旧第三方客户端缺少请求头会收到 400。
5. 保留旧密码密钥，确认新版 Service Worker 激活，再恢复流量；在预发布环境补完下方端到端验收。

迁移前只读检查（前两项返回行或后两项不满足要求时先处理冲突）：

```sql
SELECT lower(address) AS address_key, count(*) AS n
FROM email GROUP BY lower(address) HAVING count(*) > 1;
SELECT name, count(*) AS n FROM role GROUP BY name HAVING count(*) > 1;
SELECT user_id, count(*) AS n FROM user_role GROUP BY user_id HAVING count(*) > 1;
SELECT count(*) AS owners FROM user_role ur JOIN role r ON r.id = ur.role_id
WHERE r.name = 'emperor'; -- 必须 <= 1
```

账本会回填仍存在的历史 sent 消息；迁移前已经删除的发送记录无法还原。已预留但结果未知的请求继续占用当日额度，避免超时后绕过限额。重试应使用相同 key 和相同内容；明确拒绝返回 `retryWithNewKey: true`，修正问题后才可使用新 key。供应商幂等保留时间为 24 小时，本实现拒绝自动重发超过 23 小时的未决请求，需要管理员核对供应商记录；不要直接删账本后重发。

旧密码仍以原 AUTH_SECRET 验证。如果同时轮换 AUTH_SECRET，必须将原值保存为 `LEGACY_PASSWORD_SECRET`，直到旧密码迁移完成。新密码不依赖这两个密钥。PBKDF2 为 100,000 次迭代，受当前锁定 Workers WebCrypto 上限约束；这是兼容性折中，不能当作密码方案永远无需升级。生产 CPU 预算需实测。

新版禁止响应 SVG，但不会自动删除历史 SVG 或历史孤儿 R2 对象。孤儿对象需要单独对账。旧浏览器/CDN 已缓存的响应不能仅靠新响应头立即撤回；需要激活新版 Service Worker，必要时清理 CDN/站点缓存。其他系统仍持有的媒体 URL 在其过期前属于访问凭证。

## 已完成验证

遵守 AGENTS.md，未编写单元测试。以下为编译、静态核对及 `/tmp` 中合成数据的人工检查，未使用生产数据库或真实发送邮件。

- `pnpm build` 成功，包含 Next 生产编译、类型检查和页面生成。
- `pnpm lint` 成功；仍有原有的 email-list、api-key-panel hook 依赖警告和 promote-panel img 提示。
- core、CLI、MCP TypeScript 检查及 CLI/MCP Bun 打包。
- CLI 连接本地 3 秒慢响应服务，1 秒截止时间约 1.13 秒退出为 timeout；零 interval 和 NaN timeout 立即拒绝。
- Wrangler 本地 D1 从空库应用 0000–0021 全部 22 个迁移成功。
- 本地 workerd 密码验证：新密码、错误密码拒绝、随机盐差异、旧 SHA256 兼容均符合预期。
- 真实媒体 Worker + 本地 D1/R2：带 .123 毫秒的有效签名 URL 返回 200，安全响应头齐全；错误 token 返回 410；历史 SVG 返回 415。
- CID 的 `+`、`(` 字符精确替换；相似前缀不被替换；畸形 `%` 编码保持可处理。
- 10 个并发额度预留、限额 2：仅 2 个成功；满额后重试原 key 返回原预留；删邮箱后用量仍为 2。
- 同一发送并发完成只保存 1 条 message；删除后再次完成仍为 0 条，ledger 保持 sent。
- 102 个附件随过期邮箱删除后，R2 对象和队列均为 0；模拟 R2 删除失败时队列保留，恢复重试后清空；用户级联删除也生成待清理对象键。
- 两个用户并发取得 emperor：仅 1 个成功，数据库保留 1 个 emperor。
- 生产 Service Worker 产物包含隐私清理脚本、静态资源专用缓存和 NetworkOnly，不再生成旧 apis 动态缓存规则。

构建仍提示 next-on-pages 的 process.release Edge 警告、大字体不预缓存及 Browserslist 数据陈旧；这些没有被当作本次修复已消除的问题。

## 尚未完成的部署验收与后续工作

- 未执行真实 Turnstile、OAuth、Resend、Webhook 网络故障验收，未在 Cloudflare 线上部署。发送落库和幂等状态已做本地检查，供应商成功后断开数据库的完整链路仍需预发布环境验收。
- 未完成已登录桌面/移动端交互验收及真实浏览器 A/B 用户切换、离线/慢网 PWA 验收。需要验证消息快速切换、纯文本到 HTML、额度耗尽查看历史、注册后二次验证码等流程。
- Webhook 仅有限重试，没有持久化投递队列；接收方仍须按 messageId 去重。R2 与 D1 不是跨服务事务，若上传成功后的数据库写入和补偿队列写入都失败，仍需离线对象对账兜底。
- 原复审列出的依赖安全升级、通用 HTML 净化、SSRF 可达性、OAuth 关联语义、线上限流策略及查询性能尚未完整处理；不能将这次修复当成全项目安全认证。
