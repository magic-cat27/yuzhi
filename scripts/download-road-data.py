import concurrent.futures, subprocess, pathlib, gzip, hashlib, json, os
root=pathlib.Path(__file__).resolve().parents[1]/'data/datasets/project2'
(root/'archives').mkdir(parents=True,exist_ok=True)
(root/'files').mkdir(parents=True,exist_ok=True)
items=[(region,kind,ext) for region in ('NY','USA') for kind,ext in (('d','gr'),('t','gr'),('d','co'))]
def work(item):
 region,kind,ext=item
 name=f'USA-road-{kind}.{region}.{ext}'
 url=f'https://www.diag.uniroma1.it/challenge9/data/USA-road-{kind}/{name}.gz'
 archive=root/'archives'/(name+'.gz')
 dest=root/'files'/name
 if not dest.exists():
  print('Downloading '+name,flush=True)
  subprocess.run(['curl','-fLsS','--connect-timeout','30','--retry','5','--retry-delay','3','--speed-limit','1024','--speed-time','120','-C','-','-o',str(archive),url],check=True)
  h=hashlib.sha256(); size=0
  with gzip.open(archive,'rb') as source,open(str(dest)+'.part','wb') as out:
   while block:=source.read(1024*1024):out.write(block);h.update(block);size+=len(block)
  os.replace(str(dest)+'.part',dest)
  print('Verified and unpacked '+name+' '+str(size)+' bytes',flush=True)
 else:
  h=hashlib.sha256()
  with dest.open('rb') as f:
   while block:=f.read(1024*1024):h.update(block)
  size=dest.stat().st_size
 return dict(name=name,url=url,bytes=size,sha256=h.hexdigest(),compressedBytes=archive.stat().st_size)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
 results=list(pool.map(work,items))
(root/'manifest.json').write_text(json.dumps({'source':'https://www.diag.uniroma1.it/challenge9/download.shtml','files':results},indent=2)+'\n')
print('ALL SIX DATASETS READY',flush=True)
