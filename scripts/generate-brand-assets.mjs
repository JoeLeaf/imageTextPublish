import sharp from 'sharp';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const directory=new URL('../assets/brand/',import.meta.url);
const svg=await readFile(new URL('logo.svg',directory));
const png=async size=>sharp(svg).resize(size,size).png().toBuffer();
await writeFile(new URL('app-icon.png',directory),await png(512));

// Vista+ ICO supports PNG image entries; include small sizes for title/taskbar views.
const sizes=[16,24,32,48,64,128,256];
const frames=await Promise.all(sizes.map(png));
const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
let offset=header.length;
for(let i=0;i<sizes.length;i++) {
  const entry=6+i*16;header[entry]=header[entry+1]=sizes[i]===256?0:sizes[i];
  header.writeUInt16LE(1,entry+4);header.writeUInt16LE(32,entry+6);
  header.writeUInt32LE(frames[i].length,entry+8);header.writeUInt32LE(offset,entry+12);offset+=frames[i].length;
}
await writeFile(new URL('app-icon.ico',directory),Buffer.concat([header,...frames]));

const records=[];
for(const [type,size] of [['icp4',16],['icp5',32],['icp6',64],['ic07',128],['ic08',256],['ic09',512],['ic10',1024]]) {
  const data=await png(size);const entry=Buffer.alloc(8);entry.write(type,0,4,'ascii');entry.writeUInt32BE(data.length+8,4);records.push(entry,data);
}
const container=Buffer.alloc(8);container.write('icns',0,4,'ascii');container.writeUInt32BE(8+records.reduce((sum,b)=>sum+b.length,0),4);
await writeFile(new URL('app-icon.icns',directory),Buffer.concat([container,...records]));
console.log(`Brand assets generated in ${fileURLToPath(directory)}`);
