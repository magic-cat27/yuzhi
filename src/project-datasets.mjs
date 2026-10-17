import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';

// Only administrator-installed resources are mounted; never accept a host path from a request.
export async function projectDatasets(root,projectId){
  if(projectId!=='project2')return null;
  const base=path.join(root,'data/datasets/project2');
  try{
    const manifest=JSON.parse(await readFile(path.join(base,'manifest.json'),'utf8'));
    const directory=path.join(base,'files');
    for(const file of manifest.files){
      if(!/^USA-road-[dt]\.(NY|USA)\.(gr|co)$/.test(file.name))throw Error('Invalid dataset manifest');
      if((await stat(path.join(directory,file.name))).size!==file.bytes)throw Error('Dataset size mismatch');
    }
    return {directory,source:manifest.source,files:manifest.files.map(({name,bytes,sha256})=>({name,path:'datasets/'+name,bytes,sha256}))};
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}

export function datasetInstructions(datasets){
  if(!datasets)return '';
  return '\n\n## 已提供的道路数据\n工作区 datasets/ 是共享只读目录，已解压，可直接用 C fopen 或终端命令读取；无需下载、生成或申请写入。文件不属于编辑器源码，使用 run_project 的 head、ls 等命令检查，不要用 read_file 读取整张图。\n'+datasets.files.map(f=>`${f.path} (${f.bytes} bytes)`).join('\n')+'\nNY 为 New York City，USA 为 Full USA；-d 为距离权重，-t 为时间权重，.co 是两种图共用的坐标。文件为 DIMACS 格式，图头 p sp 指明节点数与弧数，a 行为起点、终点、权重。数据集原件不计入 64 MB 临时工作区，但程序加载后的内存仍受 512 MB 限制；Full USA 运行可能超限，不要把资源限制误报为数据损坏。\n';
}
