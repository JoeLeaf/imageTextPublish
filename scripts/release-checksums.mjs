import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const directory = resolve(process.argv[2] ?? 'release');
const files = (await readdir(directory, {withFileTypes: true}))
  .filter(entry => entry.isFile() && /^ImageTextPublish-.*\.(exe|dmg)$/.test(entry.name))
  .map(entry => entry.name).sort();
if (!files.length) throw new Error('目录中没有可发布的 EXE / DMG。');
const lines = [];
for (const name of files) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(resolve(directory, name))) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(resolve(directory, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'utf8');
console.log(`已为 ${files.length} 个发行包生成 SHA256SUMS.txt。`);
