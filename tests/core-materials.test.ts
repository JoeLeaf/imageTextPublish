import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { TaskConfig } from '../src/shared/types';
import { prepareBatch, rebindPreparedPosts, relocateMaterialPath, scanDirectories, scanMaterialSource, validateBatchFiles, validateConfig } from '../src/main/core';

let directory: string;
let config: TaskConfig;
beforeEach(async () => {
  // Hosted runners can expose temp paths through /var aliases or Windows 8.3 names.
  // Use the canonical parent so material fixtures do not look like linked sources.
  directory = await mkdtemp(path.join(await realpath(tmpdir()), 'publish-core-'));
  const textDirectory = path.join(directory, 'texts');
  const imageDirectory = path.join(directory, 'images');
  await mkdir(textDirectory);
  await mkdir(imageDirectory);
  config = { name: '测试任务', accountId: '08d3d3b0-dbbf-41fa-81cb-8a5334a3d92a', textDirectory, imageDirectory, postCount: 1, imagesPerPost: 1, intervalMinutes: 10, startAt: '2026-10-12T20:00:00+08:00', timezone: 'Asia/Shanghai', reuseImages: true, titleMode: 'none', visibility: 'public' };
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function addImage(name: string, red = 100) {
  const file = path.join(config.imageDirectory, name);
  await sharp({ create: { width: 2, height: 3, channels: 3, background: { r: red, g: 20, b: 40 } } }).png().toFile(file);
  return file;
}

describe('materials', () => {
  it('keeps the whole caption and decodes UTF-8 BOM and both UTF-16 byte orders in natural filename order', async () => {
    await writeFile(path.join(config.textDirectory, '稿10.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('标题十\n正文十')]));
    await writeFile(path.join(config.textDirectory, '稿2.md'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('标题二\n正文二', 'utf16le')]));
    const bigEndian = Buffer.from('标题一\n正文一', 'utf16le'); bigEndian.swap16();
    await writeFile(path.join(config.textDirectory, '稿1.text'), Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]));
    await addImage('配图.png');
    const batch = await prepareBatch({ ...config, postCount: 3 });
    expect(batch.posts.map(post => post.textFilename)).toEqual(['稿1.text', '稿2.md', '稿10.txt']);
    expect(batch.posts.map(post => post.caption)).toEqual(['标题一\n正文一', '标题二\n正文二', '标题十\n正文十']);
    expect(batch.posts.every(post => post.title === '')).toBe(true);
    expect(batch.posts.map(post => post.scheduledAt)).toEqual(['2026-10-12T12:00:00.000Z', '2026-10-12T12:10:00.000Z', '2026-10-12T12:20:00.000Z']);
    expect(batch.posts[0].images[0]).toMatchObject({ width: 2, height: 3, mime: 'image/png' });
  });

  it('reports empty, invalid encoding and corrupt image files while recursively selecting valid material', async () => {
    await mkdir(path.join(config.textDirectory, 'sub'));
    await writeFile(path.join(config.textDirectory, 'sub', '正常.txt'), '整篇正文');
    await writeFile(path.join(config.textDirectory, '空.txt'), ' \r\n');
    await writeFile(path.join(config.textDirectory, '坏编码.txt'), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(config.imageDirectory, '坏图.png'), 'not png');
    await addImage('好图.png');
    const result = await scanDirectories(config);
    expect(result.textCount).toBe(1); expect(result.imageCount).toBe(1);
    expect(result.invalidFiles).toHaveLength(3);
    expect(result.invalidFiles.join('\n')).toContain('UTF-8');
  });

  it('rejects oversized captions during scanning before a preview can exceed persistence limits', async () => {
    await writeFile(path.join(config.textDirectory, '过长.txt'), '文'.repeat(100_001));
    await addImage('配图.png');
    const result = await scanDirectories(config);
    expect(result.textCount).toBe(0);
    expect(result.invalidFiles.join('\n')).toContain('100000');
    await expect(prepareBatch(config)).rejects.toThrow('文案只有 0');
  });

  it('rejects text above 1 MiB before decoding and images above 50 MiB before image parsing', async () => {
    const text = path.join(config.textDirectory, '过大文本.txt');
    await writeFile(text, 'small');
    await truncate(text, 1024 * 1024 + 1);
    const image = await addImage('过大图片.png');
    await truncate(image, 50 * 1024 * 1024 + 1);
    const result = await scanDirectories(config);
    expect(result.textCount).toBe(0);
    expect(result.imageCount).toBe(0);
    expect(result.invalidFiles.join('\n')).toContain('文本文件超过 1 MiB');
    expect(result.invalidFiles.join('\n')).toContain('图片文件超过 50 MiB');
    expect(result.invalidFiles.join('\n')).not.toContain('文字编码无效');
  });

  it('checks byte limits again if frozen files grow after preview', async () => {
    const text = path.join(config.textDirectory, '1.txt');
    await writeFile(text, '原正文');
    const image = await addImage('1.png');
    const batch = await prepareBatch(config);
    await truncate(text, 1024 * 1024 + 1);
    await truncate(image, 50 * 1024 * 1024 + 1);
    const result = await validateBatchFiles(batch);
    expect(result.ok).toBe(false);
    expect(result.invalidFiles).toHaveLength(2);
    expect(result.invalidFiles.join('\n')).toContain('文本文件超过 1 MiB');
    expect(result.invalidFiles.join('\n')).toContain('图片文件超过 50 MiB');
  });

  it('keeps local captions over 1000 characters intact for preview', async () => {
    const caption = '文'.repeat(1001);
    await writeFile(path.join(config.textDirectory, '长正文.txt'), caption);
    await addImage('配图.png');
    const batch = await prepareBatch(config);
    expect(batch.posts[0].caption).toBe(caption);
    expect((await validateBatchFiles(batch)).ok).toBe(true);
  });

  it('skips directory links instead of following external files', async () => {
    const external = path.join(directory, 'external'); await mkdir(external);
    await writeFile(path.join(external, 'outside.txt'), '外部正文');
    await writeFile(path.join(config.textDirectory, 'inside.txt'), '内部正文');
    await symlink(external, path.join(config.textDirectory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await scanDirectories(config);
    expect(result.textCount).toBe(1);
    expect(result.invalidFiles.join('\n')).toContain('符号链接');
  });

  it('does not repeat image contents across a batch with reuse disabled or within one post', async () => {
    await writeFile(path.join(config.textDirectory, '1.txt'), '第一篇');
    await writeFile(path.join(config.textDirectory, '2.txt'), '第二篇');
    for (let index = 0; index < 4; index++) await addImage(`${index}.png`, index * 50);
    const batch = await prepareBatch({ ...config, postCount: 2, imagesPerPost: 2, reuseImages: false });
    const hashes = batch.posts.flatMap(post => post.images.map(image => image.sha256));
    expect(new Set(hashes).size).toBe(4);
    const frozen = JSON.stringify(batch.posts);
    expect((await validateBatchFiles(batch)).ok).toBe(true);
    expect((await validateBatchFiles(batch.posts)).ok).toBe(true);
    expect(JSON.stringify(batch.posts)).toBe(frozen);
  });

  it('allows equivalent text files and captions already used in another batch while keeping image rules', async () => {
    await writeFile(path.join(config.textDirectory, '1.txt'), '同一正文');
    await writeFile(path.join(config.textDirectory, '2.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('同一正文', 'utf16le')]));
    const image = await addImage('1.png'); await copyFile(image, path.join(config.imageDirectory, '2.png'));
    const duplicates = await prepareBatch({ ...config, postCount: 2 });
    expect(duplicates.posts.map(post => post.caption)).toEqual(['同一正文','同一正文']);
    expect(new Set(duplicates.posts.map(post => post.textPath)).size).toBe(2);
    await expect(prepareBatch({ ...config, imagesPerPost: 2 })).rejects.toThrow('图片只有 1');
    const batch = await prepareBatch(config);
    const reserved = new Set([batch.posts[0].textHash]);
    const repeated = await prepareBatch(config, reserved);
    expect(repeated.posts[0].textHash).toBe(batch.posts[0].textHash);
    expect(repeated.posts[0].id).not.toBe(batch.posts[0].id);
    expect(reserved.size).toBe(1);
  });

  it('only reads explicitly selected files and preserves file mode for empty selections', async () => {
    const selectedText = path.join(config.textDirectory,'2.txt');
    await writeFile(path.join(config.textDirectory,'1.txt'),'未选中的文案');
    await writeFile(selectedText,'选中的文案');
    await writeFile(path.join(config.textDirectory,'坏.txt'),Buffer.from([0xc3,0x28]));
    const selectedImage = await addImage('2.png');
    await addImage('1.png',20);
    const explicit = {...config,textFiles:[selectedText],imageFiles:[selectedImage]};
    expect(await scanDirectories(explicit)).toMatchObject({textCount:1,imageCount:1,textFiles:[selectedText],imageFiles:[selectedImage],invalidFiles:[]});
    const batch = await prepareBatch(explicit);
    expect(batch.posts[0].caption).toBe('选中的文案');
    expect(batch.posts[0].images[0].path).toBe(selectedImage);
    expect(batch.config.textFiles).toEqual([selectedText]);
    expect(await scanMaterialSource('text',config.textDirectory,[])).toEqual({count:0,invalidFiles:[]});
    expect((await scanDirectories({...config,textFiles:[]})).textCount).toBe(0);
  });

  it('supports selected files in several child directories and reports outside paths, formats, links and directories', async () => {
    const group = path.join(config.textDirectory,'子目录'); await mkdir(group);
    const selected = path.join(group,'2.md'); await writeFile(selected,'子目录正文');
    const first = path.join(config.textDirectory,'1.txt'); await writeFile(first,'主目录正文');
    const outside = path.join(directory,'outside.txt'); await writeFile(outside,'外部正文');
    const unsupported = path.join(config.textDirectory,'3.json'); await writeFile(unsupported,'{}');
    const external = path.join(directory,'external'); await mkdir(external);
    await writeFile(path.join(external,'linked.txt'),'外部链接正文');
    const linkedDirectory = path.join(config.textDirectory,'linked');
    await symlink(external,linkedDirectory,process.platform === 'win32' ? 'junction' : 'dir');
    const link = path.join(linkedDirectory,'linked.txt');
    const missing = path.join(config.textDirectory,'missing.txt');
    const source = await scanMaterialSource('text',config.textDirectory,[selected,first,first,outside,unsupported,link,group,missing]);
    expect(source.count).toBe(2);
    expect(source.invalidFiles).toHaveLength(5);
    expect(source.invalidFiles.join('\n')).toContain('不在来源目录');
    expect(source.invalidFiles.join('\n')).toContain('扩展名');
    expect(source.invalidFiles.join('\n')).toContain('符号链接');
    await addImage('配图.png');
    expect((await prepareBatch({...config,textFiles:[selected,first],postCount:2})).posts.map(post=>post.textPath)).toEqual([first,selected]);
  });

  it('revalidates size and encoding of explicit selections through the standalone selector scan', async () => {
    const large = path.join(config.textDirectory,'large.txt'); await writeFile(large,'x'); await truncate(large,1024*1024+1);
    const bad = path.join(config.textDirectory,'bad.txt'); await writeFile(bad,Buffer.from([0xc3,0x28]));
    expect(await scanMaterialSource('text',config.textDirectory,[large,bad])).toMatchObject({count:0,invalidFiles:expect.arrayContaining([expect.stringContaining('1 MiB'),expect.stringContaining('UTF-8')])});
    const image = await addImage('large.png'); await truncate(image,50*1024*1024+1);
    expect(await scanMaterialSource('image',config.imageDirectory,[image])).toMatchObject({count:0,invalidFiles:[expect.stringContaining('50 MiB')]});
  });

  it('detects changed frozen materials and rejects changed caption payload', async () => {
    const text = path.join(config.textDirectory, '1.txt'); await writeFile(text, '原正文');
    const image = await addImage('1.png');
    const batch = await prepareBatch(config);
    await writeFile(text, '更改正文'); await writeFile(image, 'changed');
    const result = await validateBatchFiles(batch);
    expect(result.ok).toBe(false); expect(result.invalidFiles).toHaveLength(2);
    await writeFile(text, '原正文'); await addImage('1.png');
    batch.posts[0].caption = '篡改后的正文';
    expect((await validateBatchFiles(batch)).ok).toBe(false);
  });

  it('rebinds imported Windows paths by relative names and verifies exact frozen contents', async () => {
    await mkdir(path.join(config.textDirectory, '子目录')); await mkdir(path.join(config.imageDirectory, '组'));
    await writeFile(path.join(config.textDirectory, '子目录', '1.txt'), '迁移正文');
    const sourceImage = await addImage('1.png'); await copyFile(sourceImage, path.join(config.imageDirectory, '组', '1.png')); await rm(sourceImage);
    const batch = await prepareBatch(config);
    const original = batch.posts[0];
    const foreign = { ...original, textPath: 'C:\\old\\texts\\子目录\\1.txt', images: original.images.map(image => ({ ...image, path: 'C:\\old\\images\\组\\1.png' })) };
    const rebound = await rebindPreparedPosts([foreign], 'C:\\old\\texts', 'C:\\old\\images', config.textDirectory, config.imageDirectory);
    expect(rebound[0].textPath).toBe(original.textPath);
    expect(rebound[0].images[0].path).toBe(original.images[0].path);
    expect(rebound[0].id).toBe(original.id);
    expect(foreign.textPath).toBe('C:\\old\\texts\\子目录\\1.txt');
    expect(relocateMaterialPath('C:\\old\\texts\\子目录\\1.txt','C:\\old\\texts',config.textDirectory)).toBe(original.textPath);
    await writeFile(original.textPath, 'different');
    await expect(rebindPreparedPosts([foreign], 'C:\\old\\texts', 'C:\\old\\images', config.textDirectory, config.imageDirectory)).rejects.toThrow('冻结素材不一致');
    await expect(rebindPreparedPosts([{ ...foreign, textPath: 'C:\\outside.txt' }], 'C:\\old\\texts', 'C:\\old\\images', config.textDirectory, config.imageDirectory)).rejects.toThrow('不在原目录');
  });
});

describe('configuration', () => {
  it('validates integer counts, absolute paths and real dated instants', () => {
    for (const change of [{ postCount: 0 }, { postCount: 1.5 }, { imagesPerPost: 0 }, { intervalMinutes: -1 }, { textDirectory: 'relative' }, { textDirectory: '/'.padEnd(4097, 'a') }, { name: 'a'.repeat(121) }, { accountId: 'invalid' }, { startAt: '2026-02-31T20:00:00+08:00' }, { startAt: '2026-10-12T20:00:00' }, { timezone: 'UTC' }]) {
      expect(() => validateConfig({ ...config, ...change })).toThrow();
    }
    const { imagesPerPost: _ignored, ...missingImageCount } = config;
    expect(validateConfig(missingImageCount).imagesPerPost).toBe(1);
    expect(validateConfig(config).textFiles).toBeUndefined();
    expect(validateConfig(config).imageFiles).toBeUndefined();
    for (const textFiles of [['relative.txt'],['C:\0bad.txt'],['x'.repeat(4097)]]) {
      expect(() => validateConfig({...config,textFiles})).toThrow();
    }
  });
});
