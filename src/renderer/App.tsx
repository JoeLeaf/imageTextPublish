import { useCallback, useEffect, useMemo, useState } from "react";
import brandLogo from "../../assets/brand/logo.svg";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
} from "antd";
import {
  CheckCircleOutlined,
  CopyOutlined,
  CloudUploadOutlined,
  DownloadOutlined,
  EditOutlined,
  ExportOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  ImportOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  TeamOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import type {
  AppSnapshot,
  OperationResult,
  PreparedBatch,
  PreparedPost,
  PublishTask,
  ScanResult,
  TaskConfig,
} from "../shared/types";

type Page = "tasks" | "accounts" | "settings";
type MaterialKind = "text" | "image";
type MaterialSummary = { count: number; invalidFiles: string[] };
const filenameOf = (value: string) => value.split(/[\\/]/).pop() || value;
const TASK_LABELS: Record<string, string> = {
  draft: "等待确认",
  scheduled: "等待定时",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  needs_attention: "需要处理",
  cancelled: "已取消",
};
const POST_LABELS: Record<string, string> = {
  pending: "待发布",
  uploading: "上传中",
  submitting: "提交中",
  submitted: "已提交",
  failed: "失败",
  uncertain: "结果待核对",
};
const COLOR: Record<string, string> = {
  draft: "default",
  scheduled: "blue",
  running: "processing",
  paused: "orange",
  completed: "green",
  needs_attention: "red",
  cancelled: "default",
  pending: "default",
  uploading: "processing",
  submitting: "processing",
  submitted: "green",
  failed: "red",
  uncertain: "orange",
};
const defaultConfig = (): TaskConfig => ({
  name: "",
  accountId: "",
  textDirectory: "",
  imageDirectory: "",
  postCount: 1,
  imagesPerPost: 1,
  intervalMinutes: 10,
  startAt: new Date().toISOString(),
  timezone: "Asia/Shanghai",
  reuseImages: true,
  titleMode: "none",
  visibility: "public",
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const dateText = (date: string) => {
  const d = new Date(date);
  return Number.isNaN(d.valueOf())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(d);
};
const localTime = (date: Date) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(date)
    .replace(" ", "T");

function DesktopTitlebar() {
  const isMac = /Mac/i.test(navigator.platform);
  return (
    <header className={`desktop-titlebar${isMac ? " is-mac" : ""}`}>
      <img className="titlebar-logo" src={brandLogo} alt="" draggable={false} />
      <span className="titlebar-product">图文发布助手</span>
      <span className="titlebar-divider" />
      <span className="titlebar-context">本地工作空间</span>
    </header>
  );
}

function MediaPreview({ path, label }: { path: string; label: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [path]);
  return (
    <div className="media-preview">
      {failed ? (
        <div className="missing-image">
          <FileImageOutlined />
          <span>图片不可用</span>
        </div>
      ) : (
        <img
          src={window.desktop.mediaUrl(path)}
          alt={label}
          onError={() => setFailed(true)}
        />
      )}
      <span className="image-label" title={label}>
        {label}
      </span>
    </div>
  );
}

function PostPreview({
  post,
  mediaEnabled = true,
}: {
  post: PreparedPost;
  mediaEnabled?: boolean;
}) {
  return (
    <div className="post-preview">
      <div className="post-meta">
        <Tag color={COLOR[post.status]}>{POST_LABELS[post.status]}</Tag>
        <span>{post.textFilename}</span>
        <span className="muted">{dateText(post.scheduledAt)}（北京时间）</span>
      </div>
      {post.title && <h3>{post.title}</h3>}
      <div className="muted small">正文 {post.caption.trim().length}/1000 字{post.title ? ` · 标题 ${post.title.length}/20 字` : ""}</div>
      {(post.caption.trim().length > 1000 || post.title.length > 20) && <Alert type="error" showIcon message="内容超过抖音限制，请修改原文本或文件名后重新生成预览。" />}
      <div className="caption">{post.caption}</div>
      {!mediaEnabled && post.images.length > 0 && (
        <Alert
          type="info"
          showIcon
          message="重绑定本机目录后显示图片"
          description="原设备路径仅供参考，不会读取原设备的图片位置。"
        />
      )}
      <div className="media-grid">
        {mediaEnabled &&
          post.images.map((img) => (
            <MediaPreview key={img.id} path={img.path} label={img.filename} />
          ))}
      </div>
      {post.error && (
        <Alert
          type={
            post.status === "uncertain"
              ? "warning"
              : post.status === "submitted"
                ? "info"
                : "error"
          }
          showIcon
          message={post.error}
        />
      )}
      {post.platformPostId && (
        <div className="muted">平台作品 ID：{post.platformPostId}</div>
      )}
      {post.submittedAt && (
        <div className="muted">
          提交时间：{dateText(post.submittedAt)}
          （平台审核与最终可见状态请以抖音为准）
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { message, modal } = AntApp.useApp();
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [page, setPage] = useState<Page>("tasks");
  const [busy, setBusy] = useState("");
  const [loadError, setLoadError] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [config, setConfig] = useState<TaskConfig>(defaultConfig);
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [materialSummaries, setMaterialSummaries] = useState<Partial<Record<MaterialKind, MaterialSummary>>>({});
  const [batch, setBatch] = useState<PreparedBatch | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [schedule, setSchedule] = useState<"now" | "later">("now");
  const [scheduleInput, setScheduleInput] = useState(() =>
    localTime(new Date(Date.now() + 3600000)),
  );
  const [accountEditor, setAccountEditor] = useState<{
    id?: string;
    name: string;
  } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailIndex, setDetailIndex] = useState(0);
  const [rebind, setRebind] = useState<{
    id: string;
    textDirectory: string;
    imageDirectory: string;
  } | null>(null);
  const api = window.desktop;

  const refresh = useCallback(async () => {
    if (!window.desktop) return;
    try {
      setSnapshot(await window.desktop.snapshot());
      setLoadError("");
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, []);
  useEffect(() => {
    if (!api) return;
    void refresh();
    return api.onChanged(() => {
      void refresh();
    });
  }, [api, refresh]);

  const perform = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
      await refresh();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setBusy("");
    }
  };
  const operation = async (
    key: string,
    action: () => Promise<OperationResult>,
  ) =>
    perform(key, async () => {
      const result = await action();
      if (result.ok) message.success(result.message);
      else message.error(result.message);
    });
  const detail = snapshot?.tasks.find((task) => task.id === detailId);
  const completed =
    snapshot?.tasks.filter((task) => task.status === "completed").length ?? 0;
  const active =
    snapshot?.tasks.filter((task) =>
      ["running", "scheduled"].includes(task.status),
    ).length ?? 0;
  const needsAttention =
    snapshot?.tasks.filter((task) => task.status === "needs_attention")
      .length ?? 0;
  const logs = useMemo(
    () =>
      snapshot?.tasks
        .flatMap((task) => [
          {
            id: task.id,
            event: `${task.config.name || "未命名任务"} · ${TASK_LABELS[task.status]}`,
            time: task.updatedAt,
            detail: task.pauseReason ?? "",
            kind: task.status,
          },
          ...task.posts
            .filter((post) => post.status !== "pending")
            .map((post) => ({
              id: post.id,
              event: `${task.config.name || "未命名任务"} / ${post.textFilename} · ${POST_LABELS[post.status]}`,
              time: post.submittedAt ?? task.updatedAt,
              detail:
                post.error ??
                (post.platformPostId
                  ? `平台作品 ID：${post.platformPostId}`
                  : ""),
              kind: post.status,
            })),
        ])
        .sort(
          (a, b) => new Date(b.time).valueOf() - new Date(a.time).valueOf(),
        ) ?? [],
    [snapshot],
  );

  if (!api)
    return (
      <div className="boot">
        <DesktopTitlebar />
        <img className="boot-logo" src={brandLogo} alt="" draggable={false} />
        <h1>图文发布助手</h1>
        <p>请通过桌面程序启动。</p>
        <p className="muted">
          浏览器页面无法访问本地目录、账号环境和任务服务。
        </p>
      </div>
    );
  if (!snapshot)
    return (
      <div className="boot">
        <DesktopTitlebar />
        {loadError ? (
          <>
            <Alert
              type="error"
              message="无法载入本地数据"
              description={loadError}
              showIcon
            />
            <Button onClick={() => void refresh()}>重新载入</Button>
          </>
        ) : (
          <Spin tip="正在载入本地工作空间…" />
        )}
      </div>
    );

  const patchConfig = (patch: Partial<TaskConfig>) => {
    setConfig((previous) => ({ ...previous, ...patch }));
    setScan(null);
    setBatch(null);
  };
  const pickDirectory = (
    field: "textDirectory" | "imageDirectory",
    forRebind = false,
  ) =>
    perform(`pick-${field}`, async () => {
      const directory = await api.selectDirectory();
      if (directory) {
        if (forRebind)
          setRebind((old) => (old ? { ...old, [field]: directory } : old));
        else patchConfig({ [field]: directory });
      }
    });
  const pickMaterials = (kind: MaterialKind, mode: "folder" | "files") =>
    perform(`pick-${kind}-${mode}`, async () => {
      const selected = await api.selectMaterials(kind, mode);
      if (!selected) return;
      const fields = kind === "text"
        ? { textDirectory: selected.directory, textFiles: mode === "files" ? selected.files : undefined }
        : { imageDirectory: selected.directory, imageFiles: mode === "files" ? selected.files : undefined };
      setConfig((previous) => ({
        ...previous,
        ...fields,
        ...(kind === "text" ? { postCount: Math.max(1, Math.min(selected.count, 1000)) } : {}),
      }));
      setMaterialSummaries((previous) => ({ ...previous, [kind]: { count: selected.count, invalidFiles: selected.invalidFiles } }));
      setScan(null);
      setBatch(null);
      if (kind === "text" && selected.count > 1000)
        message.warning(`识别到 ${selected.count} 篇文案，单批最多 1000 条，请选择部分文件分批发布。`);
      else if (selected.count === 0)
        message.warning(kind === "text" ? "没有识别到有效文案，请重新选择。" : "没有识别到有效图片，请重新选择。");
    });
  const buildConfig = (): TaskConfig => {
    if (!config.accountId) throw new Error("请先选择发布账号。");
    if (!config.name.trim()) throw new Error("请填写任务名称。");
    if (!config.textDirectory || !config.imageDirectory)
      throw new Error("请选择文本和图片，可以选择文件夹或单个、多个文件。");
    if (!Number.isInteger(config.postCount) || config.postCount < 1 || config.postCount > 1000)
      throw new Error("发布条数必须为 1 至 1000 的整数，更多文案请分批发布。");
    if (!Number.isInteger(config.imagesPerPost) || config.imagesPerPost < 1)
      throw new Error("每条图片数必须为正整数。");
    if (!Number.isFinite(config.intervalMinutes) || config.intervalMinutes < 1)
      throw new Error("发布间隔至少为 1 分钟。");
    const start =
      schedule === "later" ? new Date(`${scheduleInput}:00+08:00`) : new Date();
    if (Number.isNaN(start.valueOf()))
      throw new Error("请选择有效的定时时间。");
    if (schedule === "later" && start.valueOf() <= Date.now())
      throw new Error("定时开始时间必须晚于当前时间。");
    return {
      ...config,
      name: config.name.trim(),
      startAt: start.toISOString(),
    };
  };
  const openNewTask = () => {
    setConfig({
      ...defaultConfig(),
      accountId: snapshot.accounts[0]?.id ?? "",
    });
    setScan(null);
    setMaterialSummaries({});
    setBatch(null);
    setPreviewIndex(0);
    setSchedule("now");
    setNewTask(true);
  };
  const openDetail = (id: string) => {
    setDetailId(id);
    setDetailIndex(0);
  };
  const copyTask = (task: PublishTask) => {
    setConfig({
      ...task.config,
      name: `${task.config.name} 副本`.slice(0, 100),
      startAt: new Date().toISOString(),
      textDirectory: task.needsRebind ? "" : task.config.textDirectory,
      imageDirectory: task.needsRebind ? "" : task.config.imageDirectory,
      textFiles: task.needsRebind ? undefined : task.config.textFiles,
      imageFiles: task.needsRebind ? undefined : task.config.imageFiles,
    });
    setScan(null);
    setMaterialSummaries({});
    setBatch(null);
    setPreviewIndex(0);
    setSchedule("now");
    setDetailId(null);
    setNewTask(true);
    if (task.needsRebind)
      message.info("配置已带入，请重新选择本机文本和图片素材。");
  };
  const confirmStart = (task: PublishTask) =>
    modal.confirm({
      title:
        task.status === "paused" ? "继续发布这个任务？" : "开始发布这个任务？",
      content: (
        <>
          <p>
            账号：
            {snapshot.accounts.find((a) => a.id === task.config.accountId)
              ?.name ?? "账号不可用"}
          </p>
          <p>
            任务：{task.config.name} ·{" "}
            {task.posts.filter((post) => post.status === "pending").length}{" "}
            条待发布
          </p>
          <p>确认后程序将按照排期上传并提交至抖音。请保持电脑和程序运行。</p>
        </>
      ),
      okText: task.status === "paused" ? "确认继续" : "确认开始",
      onOk: () => operation("start", () => api.startTask(task.id)),
    });
  const confirmResolve = (
    task: PublishTask,
    post: PreparedPost,
    resolution: "submitted" | "not_published",
  ) =>
    modal.confirm({
      title:
        resolution === "submitted"
          ? "已在抖音核实这条作品已发布？"
          : "已在抖音核实这条作品未发布？",
      icon: <PauseCircleOutlined style={{ color: "#faad14" }} />,
      content: (
        <>
          <p>{post.textFilename}</p>
          <p>请先查看对应账号的创作者作品列表，核对内容与发布时间。</p>
          <p>
            {resolution === "submitted"
              ? "此操作只把本地记录标记为已提交，不会再发布。"
              : "此操作会解除“结果待核对”，允许后续重试。若实际已经发布，重试可能造成重复作品。"}
          </p>
        </>
      ),
      okText:
        resolution === "submitted" ? "我已核实：已发布" : "我已核实：未发布",
      cancelText: "返回核对",
      okButtonProps: { danger: resolution === "not_published" },
      onOk: () =>
        operation("resolve", () =>
          api.resolvePost(task.id, post.id, resolution),
        ),
    });
  const taskActions = (task: PublishTask, compact = false) => (
    <Space wrap size="small">
      {!compact && (
        <Button size="small" onClick={() => openDetail(task.id)}>
          查看详情
        </Button>
      )}
      <Button
        size="small"
        icon={<CopyOutlined />}
        disabled={!!busy}
        onClick={() => copyTask(task)}
      >
        复制任务
      </Button>
      {["draft", "paused", "needs_attention"].includes(task.status) &&
        !task.posts.some((post) => post.status === "failed") && (
          <Button
            size="small"
            type="primary"
            icon={<PlayCircleOutlined />}
            disabled={
              !!busy ||
              task.needsRebind ||
              task.posts.some((post) => post.status === "uncertain")
            }
            onClick={() => confirmStart(task)}
          >
            {task.status === "draft" ? "开始" : "继续"}
          </Button>
        )}
      {["running", "scheduled"].includes(task.status) && (
        <Button
          size="small"
          disabled={!!busy}
          icon={<PauseCircleOutlined />}
          onClick={() => void operation("pause", () => api.pauseTask(task.id))}
        >
          暂停
        </Button>
      )}
      {task.posts.some((post) => post.status === "failed") &&
        task.status !== "running" &&
        task.status !== "cancelled" && (
          <Tooltip
            title={
              task.posts.some((post) => post.status === "uncertain")
                ? "请先核对所有结果不确定的稿件"
                : "重新尝试失败稿件"
            }
          >
            <Button
              size="small"
              disabled={
                !!busy ||
                task.needsRebind ||
                task.posts.some((post) => post.status === "uncertain")
              }
              icon={<ReloadOutlined />}
              onClick={() =>
                modal.confirm({
                  title: "重试失败稿件？",
                  content:
                    "将使用已预览的原稿和图片，不重新随机选图。请保持电脑和程序运行。",
                  okText: "确认重试",
                  onOk: () => operation("retry", () => api.retryTask(task.id)),
                })
              }
            >
              重试
            </Button>
          </Tooltip>
        )}
      {!["running", "completed", "cancelled"].includes(task.status) && (
        <Button
          size="small"
          disabled={!!busy}
          onClick={() =>
            setRebind({
              id: task.id,
              textDirectory: task.config.textDirectory,
              imageDirectory: task.config.imageDirectory,
            })
          }
        >
          重绑定目录
        </Button>
      )}
      {!["completed", "cancelled"].includes(task.status) && (
        <Button
          danger
          size="small"
          disabled={!!busy}
          onClick={() =>
            modal.confirm({
              title: "取消这个任务？",
              content:
                "取消后将不再提交剩余稿件。已经提交至抖音的作品不会删除，正在提交的稿件仍可能完成。",
              okText: "取消任务",
              okButtonProps: { danger: true },
              onOk: () => operation("cancel", () => api.cancelTask(task.id)),
            })
          }
        >
          取消
        </Button>
      )}
    </Space>
  );

  const materialPicker = (kind: MaterialKind) => {
    const isText = kind === "text";
    const directory = isText ? config.textDirectory : config.imageDirectory;
    const files = isText ? config.textFiles : config.imageFiles;
    const summary = materialSummaries[kind];
    const count = (isText ? scan?.textCount : scan?.imageCount) ?? summary?.count ?? files?.length;
    const names = files?.map(filenameOf) ?? (isText ? scan?.textFiles : scan?.imageFiles)?.map(filenameOf);
    return (
      <div className="material-picker">
        <label className="field-label">{isText ? "文本素材" : "图片素材"}</label>
        <Space wrap>
          <Button disabled={!!busy} icon={<FolderOpenOutlined />} onClick={() => void pickMaterials(kind, "folder")}>
            选择文件夹
          </Button>
          <Button disabled={!!busy} icon={isText ? <FileTextOutlined /> : <FileImageOutlined />} onClick={() => void pickMaterials(kind, "files")}>
            选择文件（可多选）
          </Button>
        </Space>
        {directory ? (
          <div className="material-selection">
            <div className="material-selection-heading">
              <Tag color="blue">{files ? "指定文件" : "文件夹"}</Tag>
              <span>{count === undefined ? "待扫描" : `已识别 ${count} ${isText ? "篇文案" : "张图片"}`}</span>
            </div>
            {names && names.length > 0 && (
              <Tooltip title={<div className="material-tooltip">{names.join("\n")}</div>}>
                <div className="material-filenames">{names.slice(0, 3).join("、")}{names.length > 3 ? ` 等 ${names.length} 个文件` : ""}</div>
              </Tooltip>
            )}
            <div className="path-text muted">{files ? "所在目录：" : "素材目录："}{directory}</div>
          </div>
        ) : <p className="muted small">{isText ? "支持 TXT、MD、TEXT；可选择一个或多个文本文件，一份文本生成一条图文。" : "支持 JPG、PNG、WebP；可选择一张或多张图片，生成预览时随机配图。"}</p>}
        {!!summary?.invalidFiles.length && <Alert className="field-gap" type="warning" showIcon message={`已跳过 ${summary.invalidFiles.length} 项无效素材`} description={<div className="material-warnings">{summary.invalidFiles.join("\n")}</div>} />}
        {isText && (count ?? 0) > 1000 && <Alert className="field-gap" type="warning" showIcon message="单批最多 1000 条，请选择部分文本分批发布。" />}
      </div>
    );
  };

  return (
    <div className="app-shell">
      <DesktopTitlebar />
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <img src={brandLogo} alt="" draggable={false} />
          </span>
          <div>
            图文发布助手<small>LOCAL WORKSPACE</small>
          </div>
        </div>
        <div className="nav-title">工作空间</div>
        <button
          className={`nav-item ${page === "tasks" ? "selected" : ""}`}
          onClick={() => setPage("tasks")}
        >
          <UnorderedListOutlined />
          <span>发布任务</span>
          {needsAttention > 0 && <Badge count={needsAttention} />}
        </button>
        <button
          className={`nav-item ${page === "accounts" ? "selected" : ""}`}
          onClick={() => setPage("accounts")}
        >
          <TeamOutlined />
          <span>账号管理</span>
          <span className="nav-count">{snapshot.accounts.length}</span>
        </button>
        <button
          className={`nav-item ${page === "settings" ? "selected" : ""}`}
          onClick={() => setPage("settings")}
        >
          <SettingOutlined />
          <span>数据与记录</span>
        </button>
        <div className="sidebar-bottom">
          <span className="online-dot" />
          本地运行<small>Windows / macOS · 抖音图文</small>
        </div>
      </aside>
      <main className="workspace">
        <header className="page-header">
          <div>
            <div className="eyebrow">DOUYIN · 图文工作流</div>
            <h1>
              {page === "tasks"
                ? "发布任务"
                : page === "accounts"
                  ? "账号管理"
                  : "数据与记录"}
            </h1>
            <p>
              {page === "tasks"
                ? "从本地素材生成稿件，预览确认后开始发布。"
                : page === "accounts"
                  ? "为每个账号保存独立登录环境。"
                  : "迁移配置和任务数据，查看真实执行结果。"}
            </p>
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={busy === "refresh"}
              onClick={() =>
                void perform("refresh", async () => {
                  await refresh();
                })
              }
            >
              刷新
            </Button>
            {page === "tasks" && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={openNewTask}
                disabled={!!busy}
              >
                新建任务
              </Button>
            )}
            {page === "accounts" && (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setAccountEditor({ name: "" })}
              >
                添加账号
              </Button>
            )}
          </Space>
        </header>
        {loadError && (
          <Alert
            className="section-gap"
            type="error"
            message="本地数据刷新失败"
            description={loadError}
            showIcon
          />
        )}
        {!snapshot.adapter.available && (
          <Alert
            className="section-gap"
            type="warning"
            showIcon
            message="发布通道尚未可用"
            description={snapshot.adapter.description}
          />
        )}
        {page === "tasks" && (
          <>
            <div className="stats">
              <Card>
                <Statistic
                  title="全部任务"
                  value={snapshot.tasks.length}
                  prefix={<UnorderedListOutlined />}
                />
              </Card>
              <Card>
                <Statistic
                  title="执行 / 定时"
                  value={active}
                  prefix={<PlayCircleOutlined />}
                />
              </Card>
              <Card>
                <Statistic
                  title="需要处理"
                  value={needsAttention}
                  prefix={<PauseCircleOutlined />}
                />
              </Card>
              <Card>
                <Statistic
                  title="完成任务"
                  value={completed}
                  prefix={<CheckCircleOutlined />}
                />
              </Card>
            </div>
            <Card
              className="section-gap"
              title="任务列表"
              extra={<span className="muted">时间均为北京时间</span>}
            >
              {snapshot.tasks.length === 0 ? (
                <Empty
                  description={
                    <>
                      <div>还没有发布任务</div>
                      <span className="muted">
                        先添加账号，再选择文本和图片文件夹，或单个、多个文件。
                      </span>
                    </>
                  }
                >
                  <Button
                    type="primary"
                    onClick={
                      snapshot.accounts.length
                        ? openNewTask
                        : () => {
                            setPage("accounts");
                            setAccountEditor({ name: "" });
                          }
                    }
                  >
                    {snapshot.accounts.length
                      ? "创建第一个任务"
                      : "添加第一个账号"}
                  </Button>
                </Empty>
              ) : (
                <Table<PublishTask>
                  rowKey="id"
                  dataSource={snapshot.tasks}
                  pagination={{ pageSize: 8, hideOnSinglePage: true }}
                  scroll={{ x: 850 }}
                  columns={[
                    {
                      title: "任务",
                      dataIndex: "config",
                      render: (_, task) => (
                        <div>
                          <button
                            className="text-link"
                            onClick={() => openDetail(task.id)}
                          >
                            {task.config.name}
                          </button>
                          <div className="muted small">
                            {snapshot.accounts.find(
                              (a) => a.id === task.config.accountId,
                            )?.name ?? "账号未绑定"}
                          </div>
                        </div>
                      ),
                    },
                    {
                      title: "状态",
                      dataIndex: "status",
                      width: 120,
                      render: (status: string, task: PublishTask) => (
                        <Space size={4} wrap>
                          <Tag color={COLOR[status]}>
                            {task.needsRebind && task.posts.length === 0
                              ? "配置模板"
                              : TASK_LABELS[status]}
                          </Tag>
                          {task.needsRebind && (
                            <Tag color="orange">待重绑定</Tag>
                          )}
                        </Space>
                      ),
                    },
                    {
                      title: "进度",
                      width: 160,
                      render: (_, task) => {
                        const count = task.posts.filter(
                          (post) => post.status === "submitted",
                        ).length;
                        return (
                          <div>
                            <Progress
                              percent={
                                Math.round((count / task.posts.length) * 100) ||
                                0
                              }
                              size="small"
                              showInfo={false}
                            />
                            <span className="muted small">
                              {count} / {task.posts.length} 条已提交
                            </span>
                          </div>
                        );
                      },
                    },
                    {
                      title: "开始时间",
                      width: 150,
                      render: (_, task) => dateText(task.config.startAt),
                    },
                    {
                      title: "操作",
                      width: 300,
                      render: (_, task) => taskActions(task),
                    },
                  ]}
                />
              )}
            </Card>
            <div className="work-note">
              <FolderOpenOutlined />
              <div>
                <strong>素材留在本机，任务保留已选内容</strong>
                <p>
                  每次预览会确定本批文案、图片和排期。随机选图在重试时保持不变。
                </p>
              </div>
            </div>
          </>
        )}
        {page === "accounts" && (
          <div className="account-grid">
            {snapshot.accounts.length === 0 ? (
              <Card className="full-width">
                <Empty description="还没有账号">
                  <Button
                    type="primary"
                    onClick={() => setAccountEditor({ name: "" })}
                  >
                    添加账号
                  </Button>
                </Empty>
              </Card>
            ) : (
              snapshot.accounts.map((account) => (
                <Card key={account.id} className="account-card">
                  <div className="account-heading">
                    <div className="avatar">{account.name.slice(0, 1)}</div>
                    <div>
                      <h3>{account.name}</h3>
                      <span className="muted">抖音 · 独立账号环境</span>
                    </div>
                    <Tag
                      color={
                        account.status === "ready"
                          ? "green"
                          : account.status === "expired"
                            ? "red"
                            : "default"
                      }
                    >
                      {account.status === "ready"
                        ? "已验证"
                        : account.status === "expired"
                          ? "登录失效"
                          : "待验证"}
                    </Tag>
                  </div>
                  {account.platformUserId && (
                    <div className="muted small account-id">
                      平台用户 ID：{account.platformUserId}
                    </div>
                  )}
                  <p className="muted small account-id">登录后自动检测，关闭登录窗口会保留会话；也可手动检查登录。</p>
                  <div className="account-actions">
                    <Button
                      type="primary"
                      ghost
                      disabled={!!busy}
                      icon={<ExportOutlined />}
                      onClick={() =>
                        void perform("login", async () => {
                          await api.openAccount(account.id);
                          message.info(
                            "已打开独立登录窗口。完成登录后将自动检测，关闭窗口会保留会话。",
                          );
                        })
                      }
                    >
                      打开登录窗口
                    </Button>
                    <Button
                      disabled={!!busy}
                      loading={busy === `check-${account.id}`}
                      onClick={() =>
                        void perform(`check-${account.id}`, async () => {
                          const result = await api.checkAccount(account.id);
                          if (result.status === "ready")
                            message.success(result.message);
                          else message.warning(result.message);
                        })
                      }
                    >
                      检查登录
                    </Button>
                    <Button
                      icon={<EditOutlined />}
                      onClick={() =>
                        setAccountEditor({ id: account.id, name: account.name })
                      }
                    >
                      改名
                    </Button>
                    <Button
                      danger
                      onClick={() =>
                        modal.confirm({
                          title: `删除账号“${account.name}”？`,
                          content:
                            "相关任务可能需要重新绑定账号。已发布作品不会删除。",
                          okText: "删除账号",
                          okButtonProps: { danger: true },
                          onOk: () =>
                            perform("delete-account", async () => {
                              await api.removeAccount(account.id);
                              message.success("账号已删除");
                            }),
                        })
                      }
                    >
                      删除
                    </Button>
                  </div>
                </Card>
              ))
            )}
          </div>
        )}
        {page === "settings" && (
          <>
            <Card title="导入、导出与迁移" className="section-gap">
              <p className="muted">
                配置包含账号名称、任务规则和目录提示，不包含发布历史。导入的配置模板可通过“复制任务”生成新任务，并重新选择本机目录。
              </p>
              <Space wrap>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!!busy}
                  onClick={() =>
                    void perform("export", async () => {
                      if (await api.exportData("config"))
                        message.success("配置已导出");
                    })
                  }
                >
                  导出配置
                </Button>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={!!busy}
                  onClick={() =>
                    void perform("backup", async () => {
                      if (await api.exportData("backup"))
                        message.success("任务数据备份已导出");
                    })
                  }
                >
                  备份任务数据
                </Button>
                <Button
                  icon={<ImportOutlined />}
                  disabled={!!busy}
                  onClick={() =>
                    modal.confirm({
                      title: "导入配置或任务数据？",
                      content:
                        "导入后请检查账号与目录绑定。任务不会因为导入自动开始，请确认详情后手动开始。",
                      okText: "选择导入文件",
                      onOk: () =>
                        perform("import", async () => {
                          const result = await api.importData();
                          if (result)
                            message.success(
                              `已导入 ${result.accounts} 个账号、${result.tasks} 个任务，${result.needsRebind} 个任务需要检查目录。`,
                            );
                        }),
                    })
                  }
                >
                  导入数据
                </Button>
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={() =>
                    void perform("data-dir", () => api.revealDataDirectory())
                  }
                >
                  打开数据目录
                </Button>
              </Space>
              <div className="path-box">{snapshot.dataDirectory}</div>
              <Alert
                type="info"
                showIcon
                message="迁移说明"
                description="素材文件夹请单独拷贝；登录凭据与浏览器环境不通过配置迁移。导入后在任务详情重绑定目录。"
              />
            </Card>
            <Card
              title="执行记录"
              extra={
                <span className="muted">基于当前任务和稿件的真实状态</span>
              }
            >
              <Table
                rowKey="id"
                dataSource={logs}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                locale={{ emptyText: "暂无执行记录" }}
                columns={[
                  {
                    title: "时间",
                    dataIndex: "time",
                    width: 140,
                    render: (time: string) => dateText(time),
                  },
                  {
                    title: "事件",
                    dataIndex: "event",
                    render: (event: string, row) => (
                      <>
                        <Tag color={COLOR[row.kind]}>
                          {row.kind in TASK_LABELS
                            ? TASK_LABELS[row.kind]
                            : POST_LABELS[row.kind]}
                        </Tag>
                        {event}
                      </>
                    ),
                  },
                  {
                    title: "详情",
                    dataIndex: "detail",
                    render: (value: string) => (
                      <span className="muted">{value || "—"}</span>
                    ),
                  },
                ]}
              />
            </Card>
          </>
        )}
      </main>

      <Modal
        open={!!accountEditor}
        title={accountEditor?.id ? "修改账号名称" : "添加抖音账号"}
        okText="保存"
        confirmLoading={busy === "save-account"}
        onCancel={() => setAccountEditor(null)}
        onOk={() =>
          void perform("save-account", async () => {
            if (!accountEditor?.name.trim())
              throw new Error("请输入账号名称。");
            if (accountEditor.id)
              await api.renameAccount(
                accountEditor.id,
                accountEditor.name.trim(),
              );
            else await api.addAccount(accountEditor.name.trim());
            message.success("账号已保存");
            setAccountEditor(null);
          })
        }
      >
        <p className="muted">
          使用便于识别的名称。添加后请打开独立登录窗口，完成登录后自动检测；也可手动检查。
        </p>
        <Input
          autoFocus
          placeholder="例如：生活分享号"
          maxLength={80}
          value={accountEditor?.name ?? ""}
          onChange={(e) =>
            setAccountEditor((old) =>
              old ? { ...old, name: e.target.value } : old,
            )
          }
        />
      </Modal>

      <Drawer
        rootClassName="desktop-drawer"
        open={newTask}
        width={650}
        title="新建图文任务"
        onClose={() => {
          if (!busy) setNewTask(false);
        }}
        extra={<Tag color="blue">预览后再发布</Tag>}
        footer={
          <div className="drawer-footer">
            <Button onClick={() => setNewTask(false)} disabled={!!busy}>
              返回
            </Button>
            <Space>
              <Button
                loading={busy === "scan"}
                disabled={!!busy}
                onClick={() =>
                  void perform("scan", async () => {
                    setScan(await api.scan(buildConfig()));
                  })
                }
              >
                扫描素材
              </Button>
              <Button
                type="primary"
                icon={<FileImageOutlined />}
                loading={busy === "prepare"}
                disabled={!!busy || snapshot.accounts.length === 0}
                onClick={() =>
                  void perform("prepare", async () => {
                    const prepared = await api.prepare(buildConfig());
                    setBatch(prepared);
                    setPreviewIndex(0);
                  })
                }
              >
                生成整批预览
              </Button>
            </Space>
          </div>
        }
      >
        <div className="form-section">
          <div className="step-label">
            <span>01</span>
            <h3>账号与本地素材</h3>
          </div>
          <label className="field-label">任务名称</label>
          <Input
            placeholder="为这批稿件起一个名字"
            maxLength={100}
            value={config.name}
            onChange={(e) => patchConfig({ name: e.target.value })}
          />
          <label className="field-label">发布账号</label>
          <Select
            className="full-width"
            placeholder="选择抖音账号"
            value={config.accountId || undefined}
            options={snapshot.accounts.map((a) => ({
              value: a.id,
              label: `${a.name}${a.status === "ready" ? "" : " · 需要验证"}`,
            }))}
            onChange={(accountId) => patchConfig({ accountId })}
          />
          {snapshot.accounts.length === 0 && (
            <Alert
              className="field-gap"
              type="warning"
              message="请先在账号管理中添加账号。"
            />
          )}
          {materialPicker("text")}
          {materialPicker("image")}
          {scan && (
            <Alert
              className="field-gap"
              type={scan.invalidFiles.length ? "warning" : "success"}
              showIcon
              message={`识别到 ${scan.textCount} 篇文案、${scan.imageCount} 张图片`}
              description={
                scan.invalidFiles.length
                  ? `允许再次使用相同文案创建任务，请在预览中确认本批内容。无法使用的文件：${scan.invalidFiles.join("、")}`
                  : "允许再次使用相同文案创建任务。每份文本生成一条图文，请在预览中确认本批内容。"
              }
            />
          )}
        </div>
        <div className="form-section">
          <div className="step-label">
            <span>02</span>
            <h3>内容与选图</h3>
          </div>
          <div className="form-columns">
            <div>
              <label className="field-label">本批发布条数</label>
              <InputNumber
                className="full-width"
                min={1}
                max={1000}
                precision={0}
                value={config.postCount}
                onChange={(value) => patchConfig({ postCount: value ?? 1 })}
              />
              <p className="muted small">选择文本后默认按有效文件数量填写，可手动减少；重新选择文本会更新默认数量。</p>
            </div>
            <div>
              <label className="field-label">每条图片数</label>
              <InputNumber
                className="full-width"
                min={1}
                max={35}
                precision={0}
                value={config.imagesPerPost}
                onChange={(value) => patchConfig({ imagesPerPost: value ?? 1 })}
              />
            </div>
          </div>
          <div className="field-gap">
            <Checkbox
              checked={config.reuseImages}
              onChange={(e) => patchConfig({ reuseImages: e.target.checked })}
            >
              允许不同稿件重复使用同一张图片
            </Checkbox>
          </div>
          <p className="muted small">
            图片从所选文件夹或指定文件中随机选择。默认每条 1
            张；不允许复用时，需要足够数量的图片。
          </p>
          <label className="field-label">作品标题</label>
          <Radio.Group
            value={config.titleMode}
            onChange={(e) => patchConfig({ titleMode: e.target.value })}
          >
            <Radio value="none">不添加标题</Radio>
            <Radio value="filename">使用文本文件名</Radio>
          </Radio.Group>
          <label className="field-label">可见范围</label>
          <Radio.Group
            value={config.visibility}
            onChange={(e) => patchConfig({ visibility: e.target.value })}
          >
            <Radio value="public">公开</Radio>
            <Radio value="private">仅自己可见</Radio>
          </Radio.Group>
        </div>
        <div className="form-section">
          <div className="step-label">
            <span>03</span>
            <h3>发布排期</h3>
          </div>
          <Radio.Group
            value={schedule}
            onChange={(e) => {
              setSchedule(e.target.value);
              setBatch(null);
            }}
          >
            <Radio value="now">手动开始后立即执行</Radio>
            <Radio value="later">定时开始</Radio>
          </Radio.Group>
          {schedule === "later" && (
            <>
              <label className="field-label">
                开始时间 · 北京时间（UTC+8）
              </label>
              <Input
                type="datetime-local"
                value={scheduleInput}
                onChange={(e) => {
                  setScheduleInput(e.target.value);
                  setBatch(null);
                }}
              />
            </>
          )}
          <label className="field-label">稿件之间间隔（分钟）</label>
          <InputNumber
            className="full-width"
            min={1}
            max={10080}
            value={config.intervalMinutes}
            onChange={(value) => patchConfig({ intervalMinutes: value ?? 10 })}
          />
          <p className="muted small">
            保存任务不会自动发布。点击任务的“开始”后生效；执行期间需保持电脑和程序运行。
          </p>
        </div>
      </Drawer>

      <Modal
        open={!!batch}
        width={940}
        title="确认整批稿件"
        onCancel={() => {
          if (!busy) setBatch(null);
        }}
        footer={
          <Space>
            <Button disabled={!!busy} onClick={() => setBatch(null)}>
              返回调整
            </Button>
            <Button
              type="primary"
              loading={busy === "save-task"}
              disabled={!!busy || !!batch?.posts.some(post => post.caption.trim().length > 1000 || post.title.length > 20)}
              onClick={() =>
                void perform("save-task", async () => {
                  if (!batch) return;
                  const task = await api.createTask(batch.id);
                  setBatch(null);
                  setNewTask(false);
                  setPage("tasks");
                  openDetail(task.id);
                  message.success("任务已保存。请检查详情，再点击“开始”发布。");
                })
              }
            >
              确认并保存任务
            </Button>
          </Space>
        }
      >
        {batch && (
          <>
            <Alert
              type="info"
              showIcon
              message={`共 ${batch.posts.length} 条稿件 · 保存后仍需单独点击“开始”`}
              description={`${snapshot.accounts.find((a) => a.id === batch.config.accountId)?.name ?? "账号"} · ${batch.config.visibility === "public" ? "公开" : "仅自己可见"} · 每条 ${batch.config.imagesPerPost} 张图片 · 间隔 ${batch.config.intervalMinutes} 分钟`}
            />
            {batch.warnings.map((warning, index) => (
              <Alert
                className="field-gap"
                key={index}
                type="warning"
                message={warning}
                showIcon
              />
            ))}
            <div className="batch-preview">
              <div className="post-selector">
                {batch.posts.map((post, index) => (
                  <button
                    className={index === previewIndex ? "selected" : ""}
                    key={post.id}
                    onClick={() => setPreviewIndex(index)}
                  >
                    <span>第 {index + 1} 条</span>
                    <strong>{post.textFilename}</strong>
                    <small>
                      {post.images.length} 张图片 · {dateText(post.scheduledAt)}
                    </small>
                  </button>
                ))}
              </div>
              <PostPreview
                post={
                  batch.posts[Math.min(previewIndex, batch.posts.length - 1)]
                }
              />
            </div>
          </>
        )}
      </Modal>

      <Drawer
        rootClassName="desktop-drawer"
        open={!!detailId}
        width={840}
        title={detail?.config.name ?? "任务详情"}
        onClose={() => setDetailId(null)}
        extra={
          detail && (
            <Tag color={COLOR[detail.status]}>
              {detail.needsRebind && detail.posts.length === 0
                ? "配置模板"
                : TASK_LABELS[detail.status]}
            </Tag>
          )
        }
        footer={
          detail && (
            <div className="drawer-footer">
              <span className="muted">
                {detail.posts.filter((p) => p.status === "submitted").length} /{" "}
                {detail.posts.length} 条已提交
              </span>
              {taskActions(detail, true)}
            </div>
          )
        }
      >
        {detail ? (
          <>
            <Descriptions
              size="small"
              column={2}
              items={[
                {
                  key: "account",
                  label: "账号",
                  children:
                    snapshot.accounts.find(
                      (a) => a.id === detail.config.accountId,
                    )?.name ?? "账号未绑定",
                },
                {
                  key: "time",
                  label: "开始",
                  children: `${dateText(detail.config.startAt)}（北京时间）`,
                },
                {
                  key: "interval",
                  label: "间隔",
                  children: `${detail.config.intervalMinutes} 分钟`,
                },
                {
                  key: "visibility",
                  label: "可见范围",
                  children:
                    detail.config.visibility === "public"
                      ? "公开"
                      : "仅自己可见",
                },
                {
                  key: "text",
                  label: "文本目录",
                  span: 2,
                  children: (
                    <span className="path-text">
                      {detail.config.textDirectory}
                      {detail.config.textFiles && <div>指定 {detail.config.textFiles.length} 个文件：{detail.config.textFiles.map(filenameOf).join("、")}</div>}
                    </span>
                  ),
                },
                {
                  key: "image",
                  label: "图片目录",
                  span: 2,
                  children: (
                    <span className="path-text">
                      {detail.config.imageDirectory}
                      {detail.config.imageFiles && <div>指定 {detail.config.imageFiles.length} 个文件：{detail.config.imageFiles.map(filenameOf).join("、")}</div>}
                    </span>
                  ),
                },
              ]}
            />
            {detail.needsRebind && (
              <Alert
                className="field-gap"
                type="warning"
                showIcon
                message="必须重绑定本机目录"
                description={
                  detail.posts.length
                    ? "下列目录是原设备路径，仅供参考。重绑定并检查账号登录后，才能继续发布。"
                    : "这是导入的配置模板。点击“复制任务”，重新选择本机文本和图片文件夹，再生成预览。"
                }
              />
            )}
            {detail.pauseReason && (
              <Alert
                className="field-gap"
                type="warning"
                message={detail.pauseReason}
                showIcon
              />
            )}
            {detail.posts.some((p) => p.status === "uncertain") && (
              <Alert
                className="field-gap"
                type="warning"
                message="存在结果待核对的稿件"
                description="请先在抖音检查作品列表，再逐条确认已发布或未发布。核对前不会自动重发。"
                showIcon
              />
            )}
            {detail.posts.length === 0 && (
              <Empty description="配置模板尚未生成稿件，请复制任务后生成预览。" />
            )}
            {detail.posts.length > 0 && (
              <div className="field-gap">
                <Select
                  className="full-width"
                  value={Math.min(detailIndex, detail.posts.length - 1)}
                  onChange={setDetailIndex}
                  options={detail.posts.map((p, index) => ({
                    value: index,
                    label: `第 ${index + 1} 条 · ${p.textFilename} · ${POST_LABELS[p.status]}`,
                  }))}
                />
              </div>
            )}
            {detail.posts[Math.min(detailIndex, detail.posts.length - 1)] && (
              <>
                <PostPreview
                  mediaEnabled={!detail.needsRebind}
                  post={
                    detail.posts[Math.min(detailIndex, detail.posts.length - 1)]
                  }
                />
                {detail.posts[Math.min(detailIndex, detail.posts.length - 1)]
                  .status === "uncertain" && (
                  <div className="resolution-actions">
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        confirmResolve(
                          detail,
                          detail.posts[detailIndex],
                          "submitted",
                        )
                      }
                    >
                      已核实：已发布
                    </Button>
                    <Button
                      danger
                      disabled={!!busy}
                      onClick={() =>
                        confirmResolve(
                          detail,
                          detail.posts[detailIndex],
                          "not_published",
                        )
                      }
                    >
                      已核实：未发布
                    </Button>
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <Empty description="任务不存在或已移除" />
        )}
      </Drawer>

      <Modal
        open={!!rebind}
        title="迁移后重绑定本机目录"
        okText="确认重绑定"
        confirmLoading={busy === "rebind"}
        onCancel={() => setRebind(null)}
        onOk={() =>
          void operation("rebind", async () => {
            if (!rebind?.textDirectory || !rebind.imageDirectory)
              throw new Error("请重新选择文本和图片文件夹。");
            const result = await api.rebindTask(
              rebind.id,
              rebind.textDirectory,
              rebind.imageDirectory,
            );
            if (result.ok) setRebind(null);
            return result;
          })
        }
      >
        <p className="muted">
          选择包含原素材的文件夹。程序将检查素材与预览内容是否一致。
        </p>
        <label className="field-label">文本文件夹</label>
        <div className="directory-field">
          <Input readOnly value={rebind?.textDirectory ?? ""} />
          <Button
            disabled={!!busy}
            icon={<FolderOpenOutlined />}
            onClick={() => void pickDirectory("textDirectory", true)}
          >
            选择
          </Button>
        </div>
        <label className="field-label">图片文件夹</label>
        <div className="directory-field">
          <Input readOnly value={rebind?.imageDirectory ?? ""} />
          <Button
            disabled={!!busy}
            icon={<FolderOpenOutlined />}
            onClick={() => void pickDirectory("imageDirectory", true)}
          >
            选择
          </Button>
        </div>
      </Modal>
    </div>
  );
}
