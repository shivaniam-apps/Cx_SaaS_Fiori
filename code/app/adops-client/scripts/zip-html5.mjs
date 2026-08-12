import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(appRoot, 'dist');
const zipPath = resolve(distRoot, 'adopsclient.zip');
const xsAppPath = resolve(appRoot, 'xs-app.json');

const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let crc = i;
  for (let j = 0; j < 8; j += 1) {
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  crcTable[i] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    if (absolutePath === zipPath) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...await listFiles(root, absolutePath));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

async function addFile(parts, centralDirectory, filePath, entryName, offset) {
  const data = await readFile(filePath);
  const fileStat = await stat(filePath);
  const { dosTime, dosDate } = dosDateTime(fileStat.mtime);
  const nameBuffer = Buffer.from(entryName);
  const checksum = crc32(data);

  const localHeader = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(checksum),
    u32(data.length),
    u32(data.length),
    u16(nameBuffer.length),
    u16(0),
    nameBuffer
  ]);

  parts.push(localHeader, data);

  centralDirectory.push(Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(dosTime),
    u16(dosDate),
    u32(checksum),
    u32(data.length),
    u32(data.length),
    u16(nameBuffer.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(offset),
    nameBuffer
  ]));

  return offset + localHeader.length + data.length;
}

await mkdir(distRoot, { recursive: true });

const files = await listFiles(distRoot);
const parts = [];
const centralDirectory = [];
let offset = 0;

for (const file of files) {
  const entryName = relative(distRoot, file).split(sep).join('/');
  offset = await addFile(parts, centralDirectory, file, entryName, offset);
}

offset = await addFile(parts, centralDirectory, xsAppPath, basename(xsAppPath), offset);

const centralDirectoryOffset = offset;
const centralDirectoryBuffer = Buffer.concat(centralDirectory);
const endOfCentralDirectory = Buffer.concat([
  u32(0x06054b50),
  u16(0),
  u16(0),
  u16(centralDirectory.length),
  u16(centralDirectory.length),
  u32(centralDirectoryBuffer.length),
  u32(centralDirectoryOffset),
  u16(0)
]);

await writeFile(zipPath, Buffer.concat([...parts, centralDirectoryBuffer, endOfCentralDirectory]));
console.log(`Created ${zipPath}`);
