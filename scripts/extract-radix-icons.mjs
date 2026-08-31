import fs from 'fs';

const src = fs.readFileSync('package/dist/react-icons.cjs.development.js', 'utf8');
const names = [
  'DownloadIcon',
  'MagnifyingGlassIcon',
  'PlayIcon',
  'TrashIcon',
  'PauseIcon',
  'ResumeIcon',
  'Cross2Icon',
  'GearIcon',
  'CounterClockwiseClockIcon',
  'CopyIcon',
  'ImageIcon',
  'UpdateIcon',
  'MixerHorizontalIcon',
  'InfoCircledIcon',
  'CheckCircledIcon',
  'CrossCircledIcon',
  'LayersIcon',
  'ChevronDownIcon',
  'ChevronUpIcon',
  'ReaderIcon',
  'EnterIcon',
  'StopIcon',
  'VideoIcon',
  'FileIcon',
  'DotsHorizontalIcon',
];
const out = {};
for (const n of names) {
  const re = new RegExp(`var ${n} =[\\s\\S]*?d: "([^"]+)"`, 'm');
  const m = src.match(re);
  if (m) out[n.replace(/Icon$/, '')] = m[1];
  else console.error('missing', n);
}
fs.writeFileSync('src/popup/icon-paths.json', JSON.stringify(out, null, 2));
console.log(Object.keys(out).length, 'icons extracted');
