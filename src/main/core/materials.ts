import { createHash, randomInt, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { MediaFile, PreparedBatch, PreparedPost, ScanResult, TaskConfig } from '../../shared/types';
import { validateConfig } from './config';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.text']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const TEXT_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_BYTES = 50 * 1024 * 1024;
const naturalOrder = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
type TextSource = { path: string; filename: string; caption: string; hash: string };
type Inventory = { texts: TextSource[]; images: MediaFile[]; invalidFiles: string[] };

function decodeText(buffer: Buffer): string {
  let encoding = 'utf-8';
  let body = buffer;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) { encoding = 'utf-16le'; body = buffer.subarray(2); }
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) { encoding = 'utf-16be'; body = buffer.subarray(2); }
  else if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) body = buffer.subarray(3);
  try {
    const content = new TextDecoder(encoding, { fatal: true }).decode(body);
    if (content.includes('\0')) throw new Error('包含空字符');
    if (!content.trim()) throw new Error('文案为空');
    if (content.length > 100_000) throw new Error('文案超过 100000 个字符，请缩短后重新扫描');
    return content;
  } catch (error) {
    if (error instanceof Error && (error.message === '文案为空' || error.message.startsWith('文案超过'))) throw error;
    throw new Error('文字编码无效，请另存为 UTF-8 或带 BOM 的 UTF-16');
  }
}

async function assertDirectory(directory: string) {
  if (!directory || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)) throw new Error('素材目录必须是有效的本机绝对路径');
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`素材目录不可用或为符号链接：${directory}`);
  // Detect a symbolic link/junction in an ancestor as well as the selected root.
  const actual = await realpath(directory);
  const equal = process.platform === 'win32' ? actual.toLowerCase() === path.resolve(directory).toLowerCase() : actual === path.resolve(directory);
  if (!equal) throw new Error(`素材目录不能通过符号链接访问：${directory}`);
}

async function walk(directory: string, extensions: Set<string>, warnings: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (location.length > 4096) { warnings.push(`${location.slice(0, 4096)}：已跳过超长路径（最多 4096 个字符）`); continue; }
    if (entry.isSymbolicLink()) { warnings.push(`${location}：已跳过符号链接`); continue; }
    if (entry.isDirectory()) files.push(...await walk(location, extensions, warnings));
    else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(location);
  }
  return files.sort((a, b) => naturalOrder.compare(a, b) || a.localeCompare(b));
}

async function readImage(location: string): Promise<MediaFile> {
  const bytes = await readMaterial(location, 'image');
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !metadata.format || !['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('图片格式不支持或文件已损坏');
  // Header metadata alone can accept truncated/corrupt image payloads. Decode to validate it.
  await image.stats();
  return { id: randomUUID(), path: location, filename: path.basename(location), sha256: digest(bytes), width: metadata.width, height: metadata.height, mime: `image/${metadata.format}` };
}

async function inventorySource(kind: 'text' | 'image', directory: string, files?: readonly string[]): Promise<Inventory> {
  await assertDirectory(directory);
  const invalidFiles: string[] = [];
  const texts: TextSource[] = [];
  const images: MediaFile[] = [];
  const extensions = kind === 'text' ? TEXT_EXTENSIONS : IMAGE_EXTENSIONS;
  const candidates = files === undefined ? await walk(directory, extensions, invalidFiles) : [...files];
  const seenPaths = new Set<string>();
  for (const location of candidates.sort((a,b) => naturalOrder.compare(a,b) || a.localeCompare(b))) {
    try {
      if (!location || location.length > 4096 || location.includes('\0') || !path.isAbsolute(location)) throw new Error('素材文件必须是有效的本机绝对路径');
      const relative = path.relative(directory,location);
      if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('素材文件不在来源目录中');
      const key = process.platform === 'win32' ? path.resolve(location).toLowerCase() : path.resolve(location);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      if (!extensions.has(path.extname(location).toLowerCase())) throw new Error(kind === 'text' ? '不支持的文本文件扩展名' : '不支持的图片文件扩展名');
      if (kind === 'text') {
        const caption = decodeText(await readMaterial(location, 'text'));
        texts.push({ path: location, filename: path.basename(location), caption, hash: digest(caption) });
      } else images.push(await readImage(location));
    } catch (error) { invalidFiles.push(`${location}：${error instanceof Error ? error.message : '读取失败'}`); }
  }
  const boundedWarnings = invalidFiles.length > 1000 ? [...invalidFiles.slice(0, 999), `共有 ${invalidFiles.length} 个无效文件或路径，列表仅展示前 999 项，请整理素材目录。`] : invalidFiles;
  return { texts, images, invalidFiles: boundedWarnings.map(warning => warning.slice(0, 5000)) };
}

async function inventory(config: TaskConfig): Promise<Inventory> {
  const text = await inventorySource('text',config.textDirectory,config.textFiles);
  const image = await inventorySource('image',config.imageDirectory,config.imageFiles);
  const invalidFiles = [...text.invalidFiles,...image.invalidFiles];
  return {texts:text.texts,images:image.images,invalidFiles:invalidFiles.length > 1000 ? [...invalidFiles.slice(0,999),'无效文件过多，列表仅展示前 999 项，请整理素材来源。'] : invalidFiles};
}

export async function scanMaterialSource(kind: 'text' | 'image', directory: string, files?: readonly string[]): Promise<{count:number;invalidFiles:string[]}> {
  if (kind !== 'text' && kind !== 'image') throw new Error('素材类型无效');
  if (files && files.length > 10000) throw new Error('单次最多选择 10000 个素材文件');
  const result = await inventorySource(kind,directory,files);
  return {count:kind === 'text' ? result.texts.length : result.images.length,invalidFiles:result.invalidFiles};
}

export async function scanDirectories(config: TaskConfig): Promise<ScanResult> {
  const validated = validateConfig(config);
  const result = await inventory(validated);
  return { textCount: result.texts.length, imageCount: result.images.length, invalidFiles: result.invalidFiles, textFiles: result.texts.map(text => text.path), imageFiles: result.images.map(image => image.path) };
}

function shuffle<T>(items: readonly T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const index = randomInt(i + 1);
    [shuffled[i], shuffled[index]] = [shuffled[index], shuffled[i]];
  }
  return shuffled;
}

export async function prepareBatch(config: TaskConfig, _reservedTextHashes?: Set<string>): Promise<PreparedBatch> {
  const validated = validateConfig(config);
  const result = await inventory(validated);
  // Each source file is a usable caption, even if another task or file has identical text.
  const texts = result.texts;
  const imageSeen = new Set<string>();
  const images = result.images.filter(image => {
    if (imageSeen.has(image.sha256)) return false;
    imageSeen.add(image.sha256);
    return true;
  });
  if (texts.length < validated.postCount) throw new Error(`可用文案只有 ${texts.length} 篇，需要 ${validated.postCount} 篇`);
  const requiredImages = validated.imagesPerPost * (validated.reuseImages ? 1 : validated.postCount);
  if (images.length < requiredImages) throw new Error(`不同内容的可用图片只有 ${images.length} 张，需要 ${requiredImages} 张`);
  const pool = shuffle(images);
  const posts: PreparedPost[] = texts.slice(0, validated.postCount).map((text, index) => ({
    id: randomUUID(), textPath: text.path, textFilename: text.filename, textHash: text.hash, caption: text.caption,
    title: validated.titleMode === 'filename' ? path.parse(text.filename).name : '',
    images: (validated.reuseImages ? shuffle(images).slice(0, validated.imagesPerPost) : pool.slice(index * validated.imagesPerPost, (index + 1) * validated.imagesPerPost)).map(image => ({ ...image })),
    status: 'pending', scheduledAt: new Date(Date.parse(validated.startAt) + index * validated.intervalMinutes * 60_000).toISOString(),
  }));
  return { id: randomUUID(), config: { ...validated }, posts, createdAt: new Date().toISOString(), warnings: result.invalidFiles };
}

export interface FileValidation { ok: boolean; invalidFiles: string[] }

async function assertRegularFile(location: string) {
  const stat = await lstat(location);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('不是普通文件或为符号链接');
  const resolved = await realpath(location);
  const equal = process.platform === 'win32' ? resolved.toLowerCase() === path.resolve(location).toLowerCase() : resolved === path.resolve(location);
  if (!equal) throw new Error('文件不能通过符号链接访问');
  return stat;
}

export async function readMaterial(location: string, kind: 'text' | 'image'): Promise<Buffer> {
  if (!location || location.length > 4096 || location.includes('\0') || !path.isAbsolute(location)) throw new Error('素材文件必须是有效的本机绝对路径');
  if (!(kind === 'text' ? TEXT_EXTENSIONS : IMAGE_EXTENSIONS).has(path.extname(location).toLowerCase())) throw new Error('不支持的素材文件扩展名');
  const stat = await assertRegularFile(location);
  const maxBytes = kind === 'text' ? TEXT_MAX_BYTES : IMAGE_MAX_BYTES;
  if (stat.size > maxBytes) throw new Error(kind === 'text' ? '文本文件超过 1 MiB，请缩小后重试' : '图片文件超过 50 MiB，请缩小后重试');
  const bytes=await readFile(location);
  if(bytes.length>maxBytes)throw new Error('素材在读取期间变大，已停止处理');
  return bytes;
}

export async function validateBatchFiles(batchOrPosts: PreparedBatch | readonly PreparedPost[]): Promise<FileValidation> {
  const posts = Array.isArray(batchOrPosts) ? batchOrPosts as readonly PreparedPost[] : (batchOrPosts as PreparedBatch).posts;
  const invalidFiles: string[] = [];
  for (const post of posts) {
    try {
      if (digest(decodeText(await readMaterial(post.textPath, 'text'))) !== post.textHash || digest(post.caption) !== post.textHash) throw new Error('文案在预览后发生变化');
    } catch (error) { invalidFiles.push(`${post.textPath}：${error instanceof Error ? error.message : '文件无法读取'}`); }
    for (const image of post.images) {
      try {
        if (digest(await readMaterial(image.path, 'image')) !== image.sha256) throw new Error('图片在预览后发生变化');
      } catch (error) { invalidFiles.push(`${image.path}：${error instanceof Error ? error.message : '文件无法读取'}`); }
    }
  }
  return { ok: invalidFiles.length === 0, invalidFiles: [...new Set(invalidFiles)] };
}

export function relocateMaterialPath(file: string, oldRoot: string, newRoot: string): string {
  const pathApi = /^[a-z]:[\\/]/i.test(oldRoot) || oldRoot.startsWith('\\\\') ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(oldRoot) || !pathApi.isAbsolute(file)) throw new Error('备份中的旧素材路径无效');
  const relative = pathApi.relative(oldRoot, file);
  const segments = relative.split(/[\\/]/);
  if (!relative || pathApi.isAbsolute(relative) || segments.some(segment => segment === '..')) throw new Error('素材路径不在原目录中');
  return path.join(newRoot, ...segments);
}

export async function rebindPreparedPosts(posts: readonly PreparedPost[], oldTextDir: string, oldImageDir: string, newTextDir: string, newImageDir: string): Promise<PreparedPost[]> {
  if (!path.isAbsolute(newTextDir) || !path.isAbsolute(newImageDir)) throw new Error('新目录必须为本机绝对路径');
  await assertDirectory(newTextDir);
  await assertDirectory(newImageDir);
  const rebound = posts.map(post => ({ ...post, textPath: relocateMaterialPath(post.textPath, oldTextDir, newTextDir), images: post.images.map(image => ({ ...image, path: relocateMaterialPath(image.path, oldImageDir, newImageDir) })) }));
  const validation = await validateBatchFiles(rebound);
  if (!validation.ok) throw new Error(`新目录与冻结素材不一致：${validation.invalidFiles.join('；')}`);
  return rebound;
}
