# 抖音图文协议字段研究

> 本文保留最初参考仓库的研究记录。后续 v0.2 已独立实现并验收真实 ImageX 上传，当前官网图文走 legacy `create/`，其表单与即时 `timing=-1` 已通过联网前拦截确认。最新事实请看 [当前网页 schema](current-creator-schema.md) 和 [v0.2 验收记录](validation-v0.2.md)。下文的“未上传/未实现”描述最初研究阶段，不代表 v0.2 当前功能；真实最终作品提交仍未验收。

记录日期：2026-10-12。本文记录协议字段和独立实现的校验边界，不复制参考仓库实现。研究期间仅读取远程源码，未发送图片上传、Commit 或最终作品提交请求。

参考来源是 [cv-cat/DouYin_Spider](https://github.com/cv-cat/DouYin_Spider)。此前核实默认分支 master 的提交为 `fc8b9c2490a9561265425c26058290f01c064eda`；下列链接使用该提交固定版本。该仓库未声明标准开源许可证，不能据其公开可读就推定可复制或分发。

本文区分两类证据：**本站已登录会话的只读验证**仅覆盖账号身份接口；**参考实现**描述上传和创建字段，尚未在本应用真实账号的图文上传/发布链路中验收。参考源码中的“浏览器实测”是作者的声明，不是本项目完成了相同测试。

## 1. 已验证的账号身份

本项目真实登录会话只读验证了 `GET https://creator.douyin.com/web/api/media/user/info/`：HTTP 200、`status_code: 0`、顶层 `user.uid` 为精确数字字符串，`user.sec_uid` 为另一字符串。旧路径 `/web/api/user/info/` 在相同会话返回 HTTP 200、`status_code: 1`。

身份绑定使用 `user.uid`，不得使用 Cookie 是否存在、昵称、`sec_uid` 或不安全的大整数浮点值替代。禁止记录 Cookie、临时密钥和完整个人资料。

## 2. 临时上传授权 upload/auth/v5

[参考函数 get_image_upload_auth](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L1282) 请求 `GET /web/api/media/upload/auth/v5/`。图文进入页是 `/creator-micro/content/post/image?enter_from=publish_page&media_type=image&type=new`。

参考代码的授权请求 query：

| 字段 | 参考语义 | 本项目边界 |
| --- | --- | --- |
| `cookie_enabled` | 浏览器 Cookie 可用状态 | 使用真实页面状态，不伪造 |
| `screen_width`, `screen_height` | 当前显示属性 | 由正常网页 SDK/真实页面提供 |
| `browser_language`, `browser_platform` | 浏览器语言、平台 | Mac 不得硬编码成 Win32 |
| `browser_name`, `browser_version`, `browser_online` | 浏览器信息 | 参考声明 name 为 Mozilla、version 为 appVersion；须以当前网页为准 |
| `timezone_name` | 时间区 | 真实网页当前属性，不能等同本应用排期时区 |
| `aid` | 参考值 `1128` | 在真实网页调用确认后使用 |
| `support_h265` | 参考值 `1` | 网站功能属性，图集链路不应凭空修改 |
| `msToken`, `a_bogus` | 当前会话令牌、请求签名 | 由网站正常 SDK 生成；不可复制其他账号、固定签名或用伪造指纹代替 |

query 的平台组定义见 [Params.with_creator_platform](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/builder/params.py#L126)。`ServiceId` 和 ImageX `app_id` 不在此授权请求的参考 query 中，它们属于后续 ImageX 网关调用。

参考授权返回顶层 `auth` 是 **JSON 字符串**，解析后要求非空 `AccessKeyID`、`SecretAccessKey`、`SessionToken`。即使 HTTP 200 或 `status_code: 0`，没有这三个字段也不能视为拿到上传授权。临时授权不得持久保存、展示或写入日志；出现业务错误应停止。

参考特别区分页面预取的 `/aweme/mid/video/sts2/` 与图像 v5 授权，二者不能直接替换。授权服务 ID、app ID 不能从 STS 三字段反推。参考常量 `ServiceId=jm8ajry58r`、ImageX `app_id=2906` 来自作者记录，仍需当前官网 SDK 参数验证，不应在本项目作为未经验证的通用常量。

当前 `adapter.probe()` 的裸 GET 只是只读探测；其结果既不代表完整正常 SDK query，也不证明 `create_v2` 签名可用。不能据此自动开放发布能力。

## 3. ImageX Apply、图片字节和 Commit

参考网关为 `https://imagex.bytedanceapi.com/`，region 为 `cn-north-1`，service 为 `imagex`，使用标准 AWS Signature V4。独立实现应使用同一份实际请求 query/body 计算签名，保持 UTF-8 字节、RFC3986 编码和排序一致。实现资料：[AWS SigV4 文档](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html)。此网关使用的具体 signed headers 仍由实际服务定义，不可因为算法标准就假定所有字段已验证。

### Apply

[参考 query](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L923)：

| 字段 | 值/含义 |
| --- | --- |
| `Action` | `ApplyImageUpload` |
| `Version` | `2018-08-01` |
| `ServiceId` | 实际官网图文上传服务 ID |
| `app_id` | 实际官网 ImageX app ID |
| `user_id` | **有参考内部矛盾，见后文，待真实 SDK 确认** |
| `s` | 请求随机参数，正常 JS 随机字符串语义 |

[参考 Apply 返回解析](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L1329) 使用 `Result.UploadAddress`：

- `StoreInfos[0].StoreUri`：字节上传目标资源路径。
- `StoreInfos[0].Auth`：该上传节点的授权值，不是用户 Cookie。
- `StoreInfos[0].UploadID`：可选；参考记录但未显示其在图像传输中的用途。
- `UploadHosts[0]`：节点域名，应强制 HTTPS、拒绝内网地址和未知服务域名。
- `SessionKey`：后续 Commit 会话键。
- `UploadHeader`：服务器返回的附加上传头；本应用目前未保留此字段，应先检查当前官方 SDK 是否使用，再决定必须传递哪些字段。对头键做允许列表，不能盲目允许服务返回覆盖 Host/Cookie。

### 图片字节传输

[参考传输](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L1369) 是 `POST https://<UploadHost>/upload/v1/<StoreUri>`，请求体为图片原始 bytes。

语义字段为节点 `authorization`、`content-type: application/octet-stream`、`content-crc32`。参考还发送 `x-storage-u` 和 `content-disposition`；后者记录为 `attachment; filename="undefined"`，本应用不应直接照搬异常文件名，应确认正常官方 uploader 的实际要求。Origin/Referer 等浏览器头应由真实 Chromium 页面正常产生，不复制整套 UA、sec-fetch 或 TLS 指纹。

业务响应明确 `code: 2000` 才是字节上传确认，HTTP 200 自身不足。

### Commit

[参考 Commit](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L1406) 使用 POST ImageX 网关：

| 字段 | 值/含义 |
| --- | --- |
| query `Action` | `CommitImageUpload` |
| query `Version` | `2018-08-01` |
| query `ServiceId`, `app_id`, `user_id` | 与 Apply 对应 |
| JSON body `SessionKey` | Apply 返回的会话键 |

参考 body 只有 `SessionKey`，没有额外 `SuccessActionStatus` 字段。签名必须覆盖发送的实际 JSON 字节。

返回从 `Result.PluginResult[0]` 提取 `ImageUri`、`ImageWidth`、`ImageHeight`，还有可选 `ImageFormat`、`ImageSize`。不是把 `Results[0].Uri` 当图片标识。Commit 没有有效 URI/尺寸时停止，不能以本地猜测 URI 补齐。若尺寸缺失，可否使用本地真实解析尺寸应依据实际官方协议确认。

### 待消除的 user_id 矛盾

参考 `apply_image_upload` 的注释声明必须用真实 uid；但同文件 `post_images` 的执行代码固定 `user_id=""`，注释又声明图文 Apply 的 user_id 和 `x-storage-u` 为空。**不能选取其中任一注释就宣布字段正确。** 当前本项目 `ImageXUploader` 默认空 userId 仅是未验收扩展参数；接入正常官网 SDK 后以其当前图文链路为准，不能套用视频/视频封面 user_id。

参考 `post_images` 每张图片前单独获取 v5 授权；是否可以跨图片复用临时凭据未在本项目验收。

## 4. 图文 create_v2 payload

[参考字段构建函数](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L2139) 最终提交是 `POST /web/api/media/aweme/create_v2/`，结构根为 `item`，下含 `common`、`cover`、`anchor`。以下是结构映射，不是复制实现代码。

| 路径 | 类型 | 参考语义 |
| --- | --- | --- |
| `item.common.text` | string | 标题和正文合成后的文案 |
| `item.common.text_extra` | string | **JSON 字符串**，不是裸数组；标题/分隔标注 |
| `item.common.activity` | string | JSON 字符串，无活动时为 `[]` 的字符串 |
| `item.common.challenges` | string | JSON 字符串，无结构化话题时为空数组字符串 |
| `item.common.mentions` | string | JSON 字符串，无结构化 @ 时为空数组字符串 |
| `item.common.hashtag_source` | string | 参考默认空字符串 |
| `item.common.visibility_type` | number | `0` 公开、`1` 仅自己可见、`2` 好友可见 |
| `item.common.download` | number | `1` 允许下载，`0` 禁止 |
| `item.common.timing` | number | 即时为 `-1`，定时参考秒级时间戳 |
| `item.common.media_type` | number | 图文为 `2` |
| `item.common.images` | array | 每项为 `{uri,width,height}`；uri 必须来自图片 Commit |
| `item.common.creation_id` | string | 网站创建流程标识；不等于平台已发布作品 ID |
| `item.cover.poster` | string | 选中封面图片 URI，通常来自 images 中一张 |
| `item.anchor` | object | 无附加锚点时空对象 |

可选 common 字段包括 `mix_id`、`poi_id`、`poi_name`、`hot_sentence`；无需求时不主动生成。位置锚点还会进入 `item.anchor.poi`。首版不支持这些附加功能，不应复制参考默认值当成真实设置。

应用 `TaskConfig.visibility='public'` 映射 0，`'private'` 映射 1；private 是已经提交但仅自己可见的作品，**不是平台草稿**。本地排期器到时间才调用即时请求，此时 `timing=-1`；除非产品明确使用平台定时功能，不应同时应用本地定时和平台定时。

### 标题与正文

[参考文本模型](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L2091) 为：有标题和正文时 `text` 是“标题 + 中文句号 + 正文”，标题标注 `type:7`，分隔标注 `type:8`。标注 start/end 按 JavaScript UTF-16 code unit 计数（例如 emoji 常占 2），不能用 Unicode 字符数量替代。无标题时直接正文、无标题标注。图文模型不要与视频单独 `item_title/caption` 的模型混用。

参考 quick_publish 对标题采用 20 字限制；本项目已经根据真实页面确认标题/正文计数前，应把限制视为保守验证，不声称平台对全部字符类型完全相同。`#话题`、`@用户` 的普通字符串不等同已经绑定平台真实话题 ID/用户 ID；结构化语义需单独验收。

### Query、签名和回执

[参考最终请求](https://github.com/cv-cat/DouYin_Spider/blob/fc8b9c2490a9561265425c26058290f01c064eda/dy_apis/douyin_creator_api.py#L2621) query 有 `read_aid=2906`、creator 平台 query、`msToken`、与实际 JSON body 相关的签名。请求还需要同会话 CSRF 和网站 ticket/session 安全头。正文、visibility、images 任一变化后必须由正常网站 SDK 重新处理请求，不能重放另一内容的签名。

本项目仅允许已登录正常网站 SDK 生成真实请求所需安全材料，不实现验证码绕过、指纹伪造或复制第三方签名算法。上传授权探测成功不证明最终提交的 SDK 签名路径可用。

确认成功需要 JSON `status_code=0` 且有效、无精度损失的 `item_id`；只说明平台接受了提交，不能等同公开展示或审核通过。HTTP 200 无 item_id、非 JSON、超时或连接断开都不能标记成功；最终提交已发出后的未知状态必须标为 uncertain，人工核对，禁止自动重试。

## 5. 当前 imagex.ts 的接入建议

目前 `src/main/platform/imagex.ts` 是独立上传协议模块，尚未在真实发布桥中调用。Apply/Commit 基础字段、Commit PluginResult 解析、CRC32 和标准 HMAC 算法已有离线测试。

接入前仍应解决：真实 ServiceId/app_id；图文 user_id/x-storage-u 的矛盾；官方 SDK 使用的 UploadHeader/UploadID；实际节点域名允许列表；content-disposition/节点附加语义头。不要通过新增伪造浏览器头来“试到成功”。本次研究仅提建议，未修改该模块，避免与主代理的正常 SDK 桥调查冲突。

未完成上传/发布验收前，界面和任务启动必须继续如实显示协议不可用。

## 6. 正常官方网页 JS 进一步核实（同日）

主代理保存的官网脚本位于 `artifacts/creator-source`。本轮读取 [21-main.7059fb27.js](../artifacts/creator-source/21-main.7059fb27.js) 和 [36-lib-byted-uploader.1d77e303.js](../artifacts/creator-source/36-lib-byted-uploader.1d77e303.js)，仅读取代码，不执行上传。它们是官网脚本的协议证据，不能当作本应用完成真实端到端验收。

主脚本正常 uploader 配置明确为 `openExperiment=true`、`appId=2906`、`imageConfig.serviceId=jm8ajry58r`、`useServerCurrentTime=true`；配置函数接收当前用户 uid 并赋给 `userId`。这解决了第 3 节参考仓库内部矛盾：本应用应向正常图文 uploader 传当前已核实 uid，Apply/Commit 的 `user_id` 和传输 `X-Storage-U` 使用该用户值，不沿用参考空串。此结论来自官网配置和代码数据流，尚未实际发送图片上传。

官方 lib-byted-uploader 的协议数据流还明确了：

- 图片直传 URL 为 `/upload/v1/{oid}`，已保存脚本没有 `/store/v1/`。
- Apply 返回的 `UploadHeader` 可为 `{Key,Value}` 数组，也可为对象；官网会规范化并传至节点。
- 直传将节点 Authorization、CRC32、编码后的用户 ID 与 UploadHeader 合并。binary wrapper 设置 application/octet-stream 和 filename Content-Disposition；direct uploader 传输对象未明确提供 filename，因此本应用提供可选 filename，未提供时与 JS undefined 字符串行为兼容。
- Commit 从 `Result.Results[0]` 取基础结果，并合并 `Result.PluginResult[0]` 的图片元数据；不能只要求 PluginResult 或只认 Results.Uri。
- 官网通过 STS `CurrentTime` 校准签名时钟偏移，并在后续请求继续应用偏移。本应用新增服务器时间参数，并在 STS ExpiredTime 到期前阻止继续上传，而不是静默请求或自动重试。

`imagex.ts` 已据此独立调整：保留可信服务器上传扩展头和 UploadID、真实用户头、Results/PluginResult 合并；`normalizeImageXCredentials()` 支持 AccessKeyID/AccessKeyId 两种拼写与 CurrentTime/ExpiredTime；options 支持注入 fetch、AbortSignal、时钟和服务器授权时间。扩展头仅允许存储相关 x-* 语义，拒绝 Cookie、Host、Authorization、Origin、Content-Length 与用户 ID/临时令牌覆盖，也拒绝 CR/LF 注入。服务器节点仍限制 HTTPS 和已知存储域名，出现未知官方节点时应审查域名再扩展允许列表，不能任意放行。

全部验证使用离线 fixture 响应，未实际发送 Apply、图片 bytes、Commit 或最终作品提交。官网图文页面的当前提示（主代理读取）为最多 35 张、每张最多 50 MB、jpg/jpeg/png/webp、禁止 gif；本应用上传模块按 50 MB 拒绝超限，其他内容约束由准备流程和发布桥共同验证。

## 7. 实际 ImageX 上传验收（同日，存储操作）

经用户授权后，执行独立存储上传验收：使用账号正常已登录网页 GET 身份和临时 STS，仅保存在进程内存；本地生成 320×240 的合成 PNG；通过本项目独立实现依次完成 Apply、图片字节 transfer、Commit。三个阶段全部获得真实业务成功回执，Commit 返回尺寸 320×240。没有调用最终作品创建接口，没有产生发布作品。

首次 Apply 返回的上传节点属于 `*.bytedancevod.com`，本模块原允许列表遗漏该域名，导致在传图片前停止。依据已认证官方 ImageX 网关返回的节点，补充该精确域后重新验收通过，并新增相似恶意域名拒绝测试。没有放开任意 URL、内网节点或重定向。

验收脚本 `artifacts/check-imagex-upload.cjs` 额外拦截 `/web/api/media/aweme/create*`，覆盖 legacy 和 create_v2 作品创建路径；日志只保留阶段、HTTP 状态、公开域名后缀和返回尺寸，不记录 uid、Cookie、STS、StoreUri 或 SessionKey。测试结束已关闭 Electron，释放用户 profile。

该验收证明当前账号的独立图像存储上传链路可用，不能单独证明作品 payload、最终请求签名、平台审核或公开展示成功。作品创建仍由主代理的正常官网 SDK 桥验收决定。
