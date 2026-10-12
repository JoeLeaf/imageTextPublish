# 当前创作者网页图文 schema 核对（legacy create 与 create_v2）

核对日期：2026-10-12（会话日期，Asia/Shanghai）。证据仅来自本地保存的正常创作者网页 JS：`artifacts/creator-source/`。本文记录字段和限制，不复制第三方实现，不包含真实账号、素材或签名，不证明请求已被服务器接受。本次没有实际上传或发布。

## 已确认的传输结构

**新增真实图文路由资料后的结论：`/publish-media/image-text` 当前走 legacy `POST /web/api/media/aweme/create/`，最终 payload 是 flat、表单编码，没有外层 `{item}`。** `create_v2` 的 `{item}` 只在 API 生成器中确认，不能把它与这个路由的图文 body 混用。

调用链在新增 `153-5986.11d27d93.js` 中：`45972.DG` 生成 photo common → `76685.R8` 加图片和标题 → photo Operator `et` 调用 `44495.wE` → `103-2990` 中 `44495.wE` 用 `qs.stringify` 编码并发送 legacy `create/`。该请求设 `retries=0`、`needSign=true`、`withSecondVerify=true`、query `read_aid=2906`；接收作品 ID 路径为 `aweme.aweme_id`。

`108-9145.281c9f0e.js`，字符偏移 3230 附近的 `awemeApiMediaAwemeCreateV2`：

- URL：`/web/api/media/aweme/create_v2/`。
- 方法：`POST`。
- request data 外层为 `{ item: ... }`，API 生成器只取输入的 `item`。
- 此生成器不展示 `item` 的完整类型与服务端必填校验。不能由外层包装推断所有必填字段。

`111-4010.e73c7a80.js`，模块 `76685`、导出 `R8`（模块起点 130672，图文组装约 132549）：先复制已有 base item，再覆写以下字段。

| 图文字段 | 实际类型 / 内容 | 证据与边界 |
|---|---|---|
| `images` | **JSON 字符串**，序列化图片数组 | 元素是 `{ uri, width, height }`，不是直接数组，也没有 `image_post_info` 包装 |
| `images[].uri` | 上传响应提供的资源 URI | 来自 `uploadFile.uri`；不能使用本地路径、任意图片 URL 或自造 URI |
| `images[].width` | 图片宽度 | 来自 `uploadFile.imageWidth` |
| `images[].height` | 图片高度 | 来自 `uploadFile.imageHeight` |
| `text` | string | 标题处理后的正文；无标题时可为纯正文 |
| `text_extra` | **JSON 字符串** | 无标题、话题、提及时可为 `"[]"`；有标题时包含标题范围标记 |
| `creation_id` | 页面生成的创作标识 | 来自编辑状态的 `creation_id`，此处没有 UUID 或数值格式校验 |
| `music_id` | 可选，音频 ID | 仅选择音频时添加 |
| `music_end_time` | 可选，音频时长毫秒 | 源码使用音频 `duration × 1000` |
| `anchor` | 可选 JSON 字符串 `{id,type,content}` | 图文变换只在有效 ID 且 `type=13034` 时补充；不是基础图文必需字段 |

数组仅收集已含 `uploadFile` 的图片；前置校验拒绝尚未上传完成的图片。保存的组装链未出现 `image_post_info`；全量本地 JS 搜索也未找到这个字段。不能把其他端接口的 `image_post_info` schema 套到这里。上述 flat 图片字段通过新增路由调用链确认用于 legacy create。最终 create_v2 的 nested `item.common` / `item.cover` / `item.anchor` 不在本次真实路由中，仍未验证。

## 当前 legacy create 的完整基础字段

依据新增 `153-5986` 模块 `45972.DG`（模块起点 1669，base 组装 3331）和 `76685.R8`。独立实现见 `src/main/platform/creator-payload.ts`，构建没有网络副作用。

| flat 字段 | 基础值 / 格式 |
|---|---|
| `text` | 正文 `trim()`；有标题时按下文 type 7/8 规则前置 |
| `text_extra` | JSON 字符串；默认 `[]` |
| `activity`, `challenges`, `mentions` | 无相关功能时各为 JSON 字符串 `[]` |
| `hashtag_source` | JSON 字符串化的空字符串，即字段值含两个双引号 `""` |
| `hot_sentence` | 无热点时空字符串 |
| `visibility_type` | 0 公开 / 1 仅自己 |
| `download` | 默认 1 |
| `poster` | 原图作为封面时为该图片上传 URI，builder 默认第一张 URI |
| `upload_poster` | 仅自定义上传封面分支赋其 URI；原图封面分支不添加 |
| `images` | JSON 字符串 `[ {uri,width,height}, ... ]` |
| `creation_id` | 此批创作标识，作为 string 保持稳定 |
| `timing` | 真实网页即时发布请求为 **-1**，本地 scheduler 到点同样立即提交。网页的平台定时使用 Unix 秒；不要重复设置平台定时 |

默认基础图文**没有** `caption`、`item_title`、`video_id`、`upload_source`、`title_permission`、`aweme_type`。这些字段不可从视频分支或其他端接口搬来。上传 URI 必须由本次上传响应取得。

可选项由页面按功能追加：`user_declare_info`、`item_id`（重新编辑）、`cover_text`、`mix_id/mix_order`、锚点与 POI/商品字段、`interaction_stickers`、`open_platform_key/open_platform_info`、`limit_client_keys`、`aigc_meta`、音频字段。第一版未选择这些功能时不伪造其值。

`croppedUri` 和封面尺寸在此文件 `45972.vj` 的**修改**链使用：不是默认新图文创建必填项。新创建原图封面直接 `poster=coverInfo.uri`。

## 标题与正文：默认无标题可用

`111-4010` 模块 `76685.y9` 只拒绝 `title.length > 20`，不要求标题非空。图文初始状态 `76685.I_` 的 `title` 也是空字符串。

图文 `76685.R8` 调用 `103-2990.e3623724.js` 模块 `66450.a0` 处理标题，该模块先清除正文中旧的图文标题范围；标题为空时直接返回正文和原有其他 `textExtra`。因此默认 `titleMode=none` 应保持纯正文，`text_extra="[]"`，**不需要添加空标题、句号或 7/8 标记**。

有标题时 schema 是：

- 标题放在 `text` 起始位置，而不是只把它放到独立 `item_title`。
- `text_extra` 加一个 `{start:0,end:标题.length,hashtag_id:0,hashtag_name:"",type:7}`。
- 若标题没有以中文句号 `。` 结尾，标题后追加该句号，并加一个范围为 `[标题.length,标题.length+1)`、`type:8` 的分隔标记。
- 所有正文的其他 metadata 范围按实际前缀长度偏移。
- 字符计数与范围使用 JavaScript `.length` / `.slice`，即 UTF-16 code unit；不能改成 UTF-8 字节数或 Unicode code point 数。

枚举准确来源：`103-2990` 模块 `36496`，偏移 383476 附近：Friend=0，Hashtag=1，ImageTitle=7，ImageTitleDiviver=8，Activity=9。

## 限制与可见范围

常量来自 `57-douyin_content_index_micro_new.99a0c907.js` 模块 `23934`（起点 50836；同内容也保存在 `82-...`）。`111-4010` 的图文校验引用这些导出，不是从提示文案猜测。

| 限制 / 枚举 | 数值 | symbol → 本地变量 / 核对点 |
|---|---|---|
| 图文标题上限 | 20 UTF-16 code units；允许空标题 | `23934.oR → P=20`；`76685.y9` 使用 `title.length` |
| 正文上限 | 1000 UTF-16 code units | `23934.em → C=1000`；`76685.y9` 先调用 `58122.eA`，再检查正文 `text.length` |
| 每条图片上限 | 35 | `23934.wH → T=35`；上传区 `maxFiles` 与 `76685.C_` 引用 |
| 单图大小上限 | 52,428,800 bytes（50 MiB） | `23934.FU → x=52428800`；超过时过滤并提示 |
| 公开 | `visibility_type=0` | `23934.Qd → A=0`；导出显示映射 0=公开 |
| 仅自己可见 | `visibility_type=1` | `23934.eY → f=1`；映射 1=仅自己可见 |
| 好友可见 | `visibility_type=2` | `23934.lF → d=2`；映射 2=好友可见 |

**不能使用 102/140 作为抖音 `visibility_type`**：同一模块的 `{PUBLIC:102,PRIVATE:140,FANS:145}` 是另一个可见范围枚举。`103-2990` 模块 `72042` 也清楚区分 `visibilityType` 默认 0 与 `xgVisibilityType` 默认 102。

图片上传 accept：`image/png,image/jpeg,image/jpg,image/bmp,image/webp,image/tif`，来源 `23934.lM → et`。上传区建议 JPG/JPEG/PNG/WEBP，提示 GIF 不支持；BMP/TIF 也在 accept 中。本应用只支持 JPG/JPEG/PNG/WEBP 是自身实现范围，不应称为官网只允许这四种。比例 3:4、4:3 等是建议；当前保存的图片校验没有硬性比例阈值。

图文前置校验还要求至少一张图片、全部图片上传完成，并且 `coverInfo.uri` 或 `coverInfo.upload_uri` 存在。新增 route base 组装明确把它分别映射到 `poster` 或 `upload_poster`；新建默认图文不要求 `croppedUri`。

## common 字段证据与尚未证实部分

`123-1541.a06216b7.js` 模块 `990` 起始部分与 `109-396.0674059a.js` 模块 `62221`（common 组装约 47065）显示的是**视频 common item**：

| 字段 | 观察到的来源 |
|---|---|
| `video_id` | 视频 `vid` |
| `text`, `caption`, `item_title` | `58122.eA` 正文 / 独立标题变换 |
| `activity`, `text_extra`, `challenges`, `mentions`, `hashtag_source` | JSON 字符串，其中 `hashtag_source` 本身经 JSON stringify 成字符串值 |
| `visibility_type` | `visibilityType` atom |
| `upload_source` | 1 |
| `is_preview`, `is_post_assistant`, `title_permission` | 功能开关 / 常量；`title_permission=1` |
| `creation_id`, `sync_to_toutiao`, `ugc_activity` | `109-396` 视频分支；另一视频分支还含 `sync_to_pico` |
| `timing` | 视频排期变换默认 0；定时则 Unix 秒 |
| `download` | 用户选择 / 特定分支控制 |
| `poster`, `upload_poster`, `custom_cover_image_width/height` | 视频封面变换，不是已证明的图文封面 schema |

`58122.eA` 将纯正文 `trim()`，无独立标题时返回 `text=caption=trim后正文`、`item_title=""`；有视频独立标题时 `text=标题+空格+正文`，正文 metadata 另保留 `caption_start/caption_end`。**这与图文 `66450.a0` 的标题句号和 type=7/8 结构不同。**

新增 `153-5986` 已补足 photo base 与 legacy create 调用链；上表的视频字段仍不是 photo 基础字段。服务端接受与审核结果尚未通过真正提交验收。另一个 `/post/image` 新路由若走 create_v2，需独立核验 nested schema，不要将其与当前 legacy 路由混用。

后续只可用正常网页请求的只读/拦截式 dry-run 核对实际序列化 body、封面资源和签名；请求能够签名不等于 body 合法，也不等于作品发布成功。真正提交与平台回执验收另行进行。

## 证据文件 SHA-256

| 本地文件 | SHA-256 |
|---|---|
| `108-9145.281c9f0e.js` | `3b19f85cdc1767cb5d94aa4d154118d8f3c374532dc494f5cdf525c5751b19af` |
| `111-4010.e73c7a80.js` | `0ca0137335cf56ae040fc7868c6188f583cd2308cd5a46977e0666ba7a32c3ac` |
| `123-1541.a06216b7.js` | `9455b8244fa4e4c8b9ca344c7a4a9091fd4bb185c432ae0e9423f06da314e63a` |
| `109-396.0674059a.js` | `5d9e95f5642cf387dcb21cfd7deca90a8c220f74b3b014c8d4151a15d516c26a` |
| `57-douyin_content_index_micro_new.99a0c907.js` | `9c520b16481d9a7daba5b0e3b2ec9a7cff3c6ae618ab61516a18a63dff3d7d99` |
| `103-2990.e3623724.js` | `2ecf6d1fdffcf2a899fbcb103f4129ad0f4bf6f653549013a8533f007d79c84a` |
| `153-5986.11d27d93.js` | `a4e8dfefb910896ade09cdd6e2a021c218f5bbcea2bf191acd5e43d10fe8f16f` |
