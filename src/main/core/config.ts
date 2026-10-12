import path from 'node:path';
import { z } from 'zod';

const directory = z.string().min(1, '请选择素材目录').max(4096, '素材目录路径最多 4096 个字符').refine(value => !value.includes('\0') && path.isAbsolute(value), '素材目录必须是本机绝对路径');
const files = z.array(z.string().min(1).max(4096, '素材文件路径最多 4096 个字符').refine(value => !value.includes('\0') && path.isAbsolute(value), '素材文件必须是本机绝对路径')).max(10000, '单次最多选择 10000 个素材文件').optional();
const instant = z.string().datetime({ offset: true, message: '开始时间必须包含有效日期和时区' });

export const taskConfigSchema = z.object({
  name: z.string().trim().min(1, '请输入任务名称').max(120, '任务名称最多 120 个字符'),
  accountId: z.string().uuid('请选择有效账号'),
  textDirectory: directory,
  imageDirectory: directory,
  textFiles: files,
  imageFiles: files,
  postCount: z.number().int().min(1, '发布数量至少为 1').max(1000, '单批最多 1000 篇'),
  imagesPerPost: z.number().int().min(1, '每篇图片至少为 1').max(35, '每篇图片最多为 35').default(1),
  intervalMinutes: z.number().int().min(1, '发布间隔至少为 1 分钟').max(525600, '发布间隔过长'),
  startAt: instant,
  timezone: z.literal('Asia/Shanghai'),
  reuseImages: z.boolean(),
  titleMode: z.enum(['none', 'filename']),
  visibility: z.enum(['public', 'private']),
}).strict();

export function validateConfig(config: unknown) {
  const result = taskConfigSchema.safeParse(config);
  if (!result.success) throw new Error(result.error.issues.map(issue => issue.message).join('；'));
  return result.data;
}
