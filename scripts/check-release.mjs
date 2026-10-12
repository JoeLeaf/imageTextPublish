import {readFile} from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('发行版本需为 x.y.z。');
if (lock.version !== pkg.version || lock.packages[''].version !== pkg.version) {
  throw new Error('package.json 与 package-lock.json 的版本不一致。');
}
if (tag && tag !== `v${pkg.version}`) throw new Error(`标签 ${tag} 与版本 v${pkg.version} 不一致。`);
if (process.env.EXPECTED_ARCH && process.arch !== process.env.EXPECTED_ARCH) {
  throw new Error(`运行器架构 ${process.arch} 与目标 ${process.env.EXPECTED_ARCH} 不一致。请使用对应系统的原生运行器。`);
}
console.log(`版本检查通过：v${pkg.version} (${process.platform}/${process.arch})`);
