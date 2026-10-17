"""Trusted launcher inside an ephemeral namespace. All returned program data is untrusted."""
import base64, json, os, selectors, signal, stat, subprocess, sys, time
from pathlib import Path
request=json.loads(Path('/input.json').read_text())
os.chdir('/workspace')
for name,content in request['files'].items():
    p=Path(name);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content)
Path('artifacts').mkdir(exist_ok=True)
for item in request.get('inputs',[]):
    p=Path('artifacts')/item['name'];p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(base64.b64decode(item['data']))
start=time.monotonic()
p=subprocess.Popen(['/bin/sh','-c',request['command']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
# stdin is bounded and written without blocking the output readers.
for pipe in (p.stdin,p.stdout,p.stderr):os.set_blocking(pipe.fileno(),False)
sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,'stdout');sel.register(p.stderr,selectors.EVENT_READ,'stderr')
data=request.get('stdin','').encode();position=0
if data:sel.register(p.stdin,selectors.EVENT_WRITE,'stdin')
else:p.stdin.close()
streams={'stdout':bytearray(),'stderr':bytearray()};reason=None
while sel.get_map():
    if time.monotonic()-start>request['timeout']:reason='timeout';break
    for key,_ in sel.select(.05):
        if key.data=='stdin':
            try:position+=os.write(key.fd,data[position:position+4096])
            except BrokenPipeError:position=len(data)
            if position==len(data):sel.unregister(key.fileobj);key.fileobj.close()
            continue
        chunk=os.read(key.fd,4096)
        if not chunk:sel.unregister(key.fileobj);key.fileobj.close();continue
        streams[key.data].extend(chunk)
        if sum(map(len,streams.values()))>131072:reason='output_limit';break
    if reason:break
# Kill surviving/background descendants before collecting files. Namespace init is PID 1.
for entry in Path('/proc').iterdir():
    if entry.name.isdigit() and int(entry.name) not in (1,os.getpid()):
        try:os.kill(int(entry.name),signal.SIGKILL)
        except ProcessLookupError:pass
try:code=p.wait(timeout=2)
except subprocess.TimeoutExpired:code=-9
if reason=='output_limit':streams['stderr'].extend('\n输出超过 128 KB，已停止运行。'.encode())
if reason=='timeout':streams['stderr'].extend('\n达到运行时间限制，已停止运行。'.encode())
artifacts=[];total=0;skipped=0
# No symlinks, special files, or arbitrary executable content leave the sandbox.
def collect(fd,prefix=''):
    global total,skipped
    for name in sorted(os.listdir(fd)):
        if name.startswith('.') or '/' in name:continue
        info=os.stat(name,dir_fd=fd,follow_symlinks=False);relative=prefix+name
        if stat.S_ISDIR(info.st_mode) and relative.count('/')<4:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:collect(child,relative+'/')
            finally:os.close(child)
        elif stat.S_ISREG(info.st_mode) and Path(name).suffix.lower() in ('.png','.jpg','.jpeg','.csv','.txt','.json','.pdf'):
            if info.st_size>2097152 or total+info.st_size>4194304 or len(artifacts)>=20:skipped+=1;continue
            child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            try:
                actual=os.fstat(child)
                if not stat.S_ISREG(actual.st_mode):continue
                with os.fdopen(child,'rb',closefd=False) as f:content=f.read(2097153)
            finally:os.close(child)
            if len(content)>2097152:skipped+=1;continue
            total+=len(content);artifacts.append({'name':relative,'data':base64.b64encode(content).decode()})
try:
    fd=os.open('artifacts',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:collect(fd)
    finally:os.close(fd)
except OSError:skipped+=1
result={'exitCode':code,'reason':reason,'stdout':bytes(streams['stdout'][:131072]).decode('utf-8','replace'),'stderr':bytes(streams['stderr'][:131072]).decode('utf-8','replace'),'artifacts':artifacts,'skipped':skipped}
sys.stdout.write(json.dumps(result,ensure_ascii=True))
